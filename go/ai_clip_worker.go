package logic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"podcastor/config"
	"podcastor/repository/model"
	"podcastor/repository/vo"
	clipservice "podcastor/services/ai_clip"
	"podcastor/services/oss_service"
	"podcastor/services/rabbitmq"
	"podcastor/third_party/aliyun/oss"
	render "podcastor/third_party/digital_human_all_in_one"
	"podcastor/third_party/highlight"
	"podcastor/third_party/node_subtitles"
	"podcastor/third_party/tencent"
	"podcastor/third_party/tikhub"
	"podcastor/util/cdslog"
)

type aiClipTerminalError struct {
	code, message string
	cause         error
}

// Error 返回终止性 AI Clip 错误的原始详情。
// 有底层错误时保留其完整字符串，否则使用本地错误码和说明。
func (e *aiClipTerminalError) Error() string {
	if e.cause != nil {
		return e.cause.Error()
	}
	return e.code + ": " + e.message
}

// Unwrap 返回终止性错误包装的原始错误。
// 它让错误链查询继续识别底层错误，用户提示仍单独保存在 message 中。
func (e *aiClipTerminalError) Unwrap() error { return e.cause }

// aiClipTerminal 创建会永久终止当前任务的错误。
// 它分别保存公开错误码、用户提示和可选原始错误，避免丢失底层诊断信息。
func aiClipTerminal(code, message string, cause ...error) error {
	err := &aiClipTerminalError{code: code, message: message}
	if len(cause) > 0 {
		err.cause = cause[0]
	}
	return err
}

type aiClipExecution struct {
	ctx            context.Context
	kind           string
	task           *model.AIClipTask
	data           any
	dataPath       string
	exportRevision int
}

// save 持久化 worker 当前任务状态和阶段数据的 OSS 路径。
// 它先上传 JSON，再保存状态；收费任务失败时在同一事务退款，导出核对本次编辑版本。
func (w *aiClipExecution) save() error {
	t := w.task
	dataPath, err := clipservice.StoreData(w.ctx, t.UniqueID, w.dataPath, w.data)
	if err != nil {
		return err
	}
	values := map[string]any{"data_path": dataPath, "status": t.Status, "stage": t.Stage, "external_id": t.ExternalID, "error_code": t.ErrorCode, "error_message": t.ErrorMessage, "err_detail": t.ErrDetail}
	var expectedPath []string
	if d, ok := w.data.(*model.AIClipSourceData); ok && d.DeferredDownload && dataPath != w.dataPath {
		// 迟到的元信息消息不能把已经扣费激活的来源覆盖回等待状态。
		expectedPath = []string{w.dataPath}
	}
	if err := aiClipBillingTransaction(w.ctx, func(ctx context.Context) error {
		if err := model.AIClipSaveTask(ctx, w.kind, t.UniqueID, w.exportRevision, values, expectedPath...); err != nil {
			return err
		}
		if t.Status == "failed" {
			return aiClipRefundFailedTask(ctx, w.kind, t.UniqueID)
		}
		if d, ok := w.data.(*model.AIClipJobData); ok && t.Status == "succeeded" && d.ResultType == "empty" && d.EmptyReason == "all_media_failed" {
			return aiClipRefundTask(ctx, w.kind, t.UniqueID, dataPath)
		}
		return nil
	}); err != nil {
		return err
	}
	w.dataPath = dataPath
	return nil
}

// saveError 保存未能随正常状态写入的原始错误详情。
// 它仅更新数据库错误列，不依赖 OSS；沿用非终态和导出版本条件，写入失败时记录日志。
func (w *aiClipExecution) saveError(err error) {
	if w.task == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(w.ctx), 10*time.Second)
	defer cancel()
	if saveErr := model.AIClipSaveTask(ctx, w.kind, w.task.UniqueID, w.exportRevision, map[string]any{"err_detail": err.Error()}); saveErr != nil {
		cdslog.W(ctx).Warn("AI Clip error detail could not be saved: "+saveErr.Error()+"; original error: "+err.Error(), zap.String("id", w.task.UniqueID), zap.Error(err), zap.NamedError("save_error", saveErr))
	}
}

// transition 将 worker 任务推进到下一个持久化阶段。
// 擦除任务始终保留腾讯 MPS TaskId；其他任务清除上一阶段的外部任务 ID。
func (w *aiClipExecution) transition(stage string) {
	w.task.Stage = stage
	if w.kind != "erase" {
		w.task.ExternalID = ""
	}
}

// submitted 记录已经确认的外部任务标识。
// 它保存有效任务 ID，提交失败或缺少 ID 时返回错误，由现有消费流程重试。
func (w *aiClipExecution) submitted(id string, err error) error {
	if err != nil {
		return err
	}
	if id == "" {
		return errors.New("external submission returned no task ID")
	}
	w.task.ExternalID = id
	return nil
}

// mediaTask 提交或轮询一个异步媒体处理任务。
// 它在缺少任务 ID 时提交新任务，否则查询已保存的任务并返回统一状态。
func (w *aiClipExecution) mediaTask(create func() (int64, error)) (string, json.RawMessage, error) {
	if w.task.ExternalID == "" {
		id, err := create()
		if id <= 0 && err == nil {
			err = errors.New("missing task ID")
		}
		return "running", nil, w.submitted(strconv.FormatInt(id, 10), err)
	}
	id, err := strconv.ParseInt(w.task.ExternalID, 10, 64)
	if err != nil {
		return "", nil, aiClipTerminal("INVALID_TASK", "invalid media task ID", err)
	}
	status, result, err := clipservice.QueryMediaTask(w.ctx, id)
	if err != nil {
		return "", nil, err
	}
	if status == "failed" {
		return status, nil, aiClipTerminal("UPSTREAM_FAILED", "media processing failed")
	}
	return status, result, nil
}

// ProcessAIClipMessage 推进一个持久化 AI Clip 任务步骤。
// 它执行并保存一个阶段及原始错误；读取、保存异常和 panic 另行记录详情，重试仍交给 MQ。
func ProcessAIClipMessage(ctx context.Context, message AIClipMessage) (resultErr error) {
	deliveryCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, 12*time.Minute)
	defer cancel()
	w := &aiClipExecution{ctx: ctx, kind: message.Kind}
	saved := false
	defer func() {
		fields := []zap.Field{zap.String("kind", message.Kind), zap.String("id", message.ID)}
		if w.task != nil {
			fields = append(fields, zap.String("stage", w.task.Stage), zap.String("external_id", w.task.ExternalID))
		}
		if recovered := recover(); recovered != nil {
			panicErr, ok := recovered.(error)
			if !ok {
				panicErr = fmt.Errorf("%v", recovered)
			}
			cdslog.W(ctx).Error("AI Clip task panicked: "+panicErr.Error(), append(fields, zap.Error(panicErr))...)
			w.saveError(panicErr)
			panic(recovered)
		}
		if resultErr != nil && !saved {
			cdslog.W(ctx).Warn("AI Clip task processing failed: "+resultErr.Error(), append(fields, zap.Error(resultErr))...)
			w.saveError(resultErr)
		}
	}()
	var load func() error
	var run func() error
	var err error
	switch message.Kind {
	case "source":
		var s model.AIClipSource
		if err := model.AIClipGetInternal(ctx, &s, message.ID); err != nil {
			return err
		}
		w.task = &s.AIClipTask
		w.data = &s.Data
		w.dataPath = s.DataPath
		load = func() error { return clipservice.ReadSourceData(ctx, &s) }
		run = func() error { return w.sourceStep(&s, &s.Data) }
	case "job":
		var j model.AIClipJob
		if err := model.AIClipGetInternal(ctx, &j, message.ID); err != nil {
			return err
		}
		w.task = &j.AIClipTask
		w.data = &j.Data
		w.dataPath = j.DataPath
		load = func() error { return clipservice.ReadData(ctx, j.DataPath, &j.Data) }
		run = func() error { return w.jobStep(&j, &j.Data) }
	case "erase":
		var t model.AIClipErase
		if err := model.AIClipGetInternal(ctx, &t, message.ID); err != nil {
			return err
		}
		w.task = &t.AIClipTask
		w.data = &t.Data
		w.dataPath = t.DataPath
		load = func() error { return clipservice.ReadData(ctx, t.DataPath, &t.Data) }
		run = func() error { return w.eraseStep(&t, &t.Data) }
	case "export":
		t, err := model.AIClipGetExport(ctx, message.ID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		w.task = &t.AIClipTask
		w.data = &t.Data
		w.dataPath = t.DataPath
		w.exportRevision = t.Revision
		load = func() error { return clipservice.ReadData(ctx, t.DataPath, &t.Data) }
		run = func() error { return w.exportStep(t, &t.Data) }
	default:
		return errors.New("unknown AI Clip message")
	}
	if w.task.Status != "queued" && w.task.Status != "running" {
		return nil
	}
	if err := load(); err != nil {
		return err
	}
	if message.Kind == "job" && w.task.Stage == "prepare" {
		// 裁剪轮询跟随整次消费取消，单次中台请求仍使用客户端超时。
		w.ctx = deliveryCtx
	}
	if message.Kind == "source" && (w.task.Stage == "download_video" || w.task.Stage == "download_audio") {
		// 代理带宽有限，大文件下载随 MQ 消费取消，不受普通步骤的十二分钟上限影响。
		w.ctx = deliveryCtx
	}
	w.task.Status = "running"
	w.task.ErrDetail = ""
	err = run()
	if err != nil {
		w.task.ErrDetail = err.Error()
		var terminal *aiClipTerminalError
		if errors.As(err, &terminal) {
			w.task.Status = "failed"
			w.task.ErrorCode = terminal.code
			w.task.ErrorMessage = terminal.message
		}
		logMessage := "AI Clip task step failed: "
		if w.task.Status == "failed" {
			if d, ok := w.data.(*model.AIClipSourceData); ok {
				if d.MediaStatus == "ready" {
					d.TranscriptStatus = "failed"
				} else {
					d.MediaStatus = "failed"
				}
			}
			logMessage = "AI Clip task failed: "
		}
		cdslog.W(ctx).Warn(logMessage+err.Error(), zap.String("kind", w.kind), zap.String("id", w.task.UniqueID), zap.String("stage", w.task.Stage), zap.String("code", w.task.ErrorCode), zap.String("external_id", w.task.ExternalID), zap.Error(err))
	}
	saveCtx, saveCancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer saveCancel()
	w.ctx = saveCtx
	if saveErr := w.save(); saveErr != nil {
		return saveErr
	}
	saved = true
	if w.task.Status != "failed" {
		return err
	}
	return nil
}

// sourceStep 解析、下载、探测并转录一个来源。
// 它按持久化阶段推进，使 YouTube、上传、项目、媒体和 ASR 工作可以独立恢复。
func (w *aiClipExecution) sourceStep(source *model.AIClipSource, d *model.AIClipSourceData) error {
	id := source.UniqueID
	if d.DeferredDownload && d.MediaStatus != "ready" && w.task.Stage != "metadata" {
		paid, err := model.AIClipHasPaidJob(w.ctx, id)
		if err != nil {
			return err
		}
		if !paid {
			w.task.Status = "waiting_generate"
			d.MediaStatus = "not_prepared"
			return nil
		}
		d.MediaStatus = "importing"
	}
	switch w.task.Stage {
	case "metadata":
		if d.YouTubeMetadata == nil {
			info, err := tikhub.GetVideoInfo(w.ctx, d.YouTubeID)
			if errors.Is(err, tikhub.ErrUnsupportedVideo) {
				return aiClipTerminal("UNSUPPORTED_SOURCE", "live or upcoming videos are unavailable", err)
			}
			if err != nil {
				return err
			}
			d.Name = info.Title
			d.YouTubeMetadata = &model.AIClipYouTubeMetadata{Duration: float64(info.Duration), CoverURL: info.ThumbnailURL}
		}
		// 封面失败时保存已取得的元信息，MQ 重试不重复调用收费的 TikHub 元信息接口。
		coverURL, err := clipservice.CacheYouTubeCover(w.ctx, id, d.YouTubeID, d.YouTubeMetadata.CoverURL)
		if err != nil {
			return err
		}
		d.YouTubeMetadata.CoverURL = coverURL
		d.MediaStatus = "not_prepared"
		w.transition("resolve")
		w.task.Status = "waiting_generate"
	case "resolve":
		if d.YouTubeMetadata == nil || d.YouTubeMetadata.CoverURL == "" {
			coverURL, err := clipservice.CacheYouTubeCover(w.ctx, id, d.YouTubeID, "https://i.ytimg.com/vi/"+d.YouTubeID+"/maxresdefault.jpg")
			if err != nil {
				return err
			}
			d.YouTubeMetadata = &model.AIClipYouTubeMetadata{CoverURL: coverURL}
		}
		if d.DownloadProxyURL == "" {
			proxyURL, err := tikhub.NewDownloadProxyURL()
			if err != nil {
				return err
			}
			d.DownloadProxyURL = proxyURL
			// 先冻结会话，再调用供应商；网络失败和 MQ 重投继续复用同一地址。
			if err := w.save(); err != nil {
				return err
			}
		}
		streams, err := tikhub.GetVideoStreams(w.ctx, d.YouTubeID, d.DownloadProxyURL)
		if err != nil {
			return err
		}
		selection, err := tikhub.Select(streams, 1080)
		if err != nil {
			return aiClipTerminal("UNSUPPORTED_SOURCE", err.Error(), err)
		}
		d.DownloadProxyExitIP = streams.ProxyExitIP
		d.DownloadVideoURL = selection.VideoURL
		d.DownloadAudioURL = selection.AudioURL
		d.DownloadVideoHeaders = selection.VideoHeaders
		d.DownloadAudioHeaders = selection.AudioHeaders
		d.DownloadExpiresAt = selection.ExpiresAt
		d.Media.Duration = selection.Duration
		d.YouTubeMetadata.Duration = selection.Duration
		if selection.Title != "" {
			d.Name = selection.Title
		}
		w.transition("download_video")
		if d.DownloadVideoKey != "" {
			d.DownloadVideoURL = ""
			d.DownloadVideoHeaders = nil
			w.transition("download_audio")
		}
	case "download_video", "download_audio":
		var downloadErr error
		if d.DownloadProxyURL == "" || d.DownloadProxyExitIP == "" {
			downloadErr = fmt.Errorf("%w: source snapshot has no verified proxy session", clipservice.ErrYouTubeSessionChanged)
		} else if time.Now().Unix() >= d.DownloadExpiresAt {
			downloadErr = fmt.Errorf("%w: YouTube stream URL expired", clipservice.ErrYouTubeSessionChanged)
		}
		raw, key := d.DownloadVideoURL, clipservice.ObjectKey(id, "video.mp4")
		headers := d.DownloadVideoHeaders
		if w.task.Stage == "download_audio" {
			raw = d.DownloadAudioURL
			headers = d.DownloadAudioHeaders
			key = clipservice.ObjectKey(id, "audio.m4a")
		}
		if downloadErr == nil {
			_, downloadErr = clipservice.DownloadToOSS(w.ctx, raw, key, headers, &clipservice.YouTubeDownloadSession{
				ProxyURL: d.DownloadProxyURL, ProxyExitIP: d.DownloadProxyExitIP,
			})
		}
		if downloadErr != nil {
			if errors.Is(downloadErr, clipservice.ErrYouTubeSessionChanged) {
				// 已完成的 OSS 产物保留；丢弃旧签名和会话，由下一次消费重新解析，仍受三次上限约束。
				d.DownloadProxyURL, d.DownloadProxyExitIP = "", ""
				d.DownloadVideoURL, d.DownloadAudioURL = "", ""
				d.DownloadVideoHeaders, d.DownloadAudioHeaders = nil, nil
				d.DownloadExpiresAt = 0
				w.transition("resolve")
			}
			return downloadErr
		}
		if w.task.Stage == "download_audio" {
			d.DownloadAudioKey = key
			d.DownloadAudioURL = ""
			d.DownloadAudioHeaders = nil
			d.DownloadProxyURL, d.DownloadProxyExitIP = "", ""
			w.transition("merge_probe")
		} else {
			d.DownloadVideoKey = key
			d.DownloadVideoURL = ""
			d.DownloadVideoHeaders = nil
			if d.DownloadAudioURL != "" {
				w.transition("download_audio")
			} else {
				d.Media.ObjectKey = key
				w.transition("probe")
			}
		}
	case "merge_probe":
		status, raw, err := w.mediaTask(func() (int64, error) {
			return clipservice.CreateProbe(w.ctx, d.DownloadVideoKey, clipservice.ObjectKey(id, "video-cover"), source.UserID)
		})
		if err != nil {
			return err
		}
		if status != "completed" {
			return nil
		}
		media, err := clipservice.ProbeResult(w.ctx, d.DownloadVideoKey, raw)
		if err != nil {
			return err
		}
		d.Media = media
		w.transition("merge")
	case "merge":
		status, raw, err := w.mediaTask(func() (int64, error) {
			return clipservice.CreateMerge(w.ctx, d.DownloadVideoKey, d.DownloadAudioKey, clipservice.ObjectKey(id, "source"), source.UserID)
		})
		if err != nil {
			return err
		}
		if status != "completed" {
			return nil
		}
		key, err := clipservice.OutputKey(raw)
		if err != nil {
			return aiClipTerminal("INVALID_MEDIA", err.Error(), err)
		}
		// 确认合并完成后才回收输入；标签失败保留 merge 阶段和外部任务 ID，重试复用产物。
		if err := oss_service.SetProjectStorageTagByPlan(w.ctx, key, source.UserID, source.SpaceID); err != nil {
			return fmt.Errorf("set merged YouTube source storage tag for %s: %w", key, err)
		}
		for _, temporaryKey := range []string{d.DownloadVideoKey, d.DownloadAudioKey} {
			if temporaryKey == "" || temporaryKey == key {
				continue
			}
			if err := oss.SetObjectTag(temporaryKey, oss.LIVED7); err != nil {
				return fmt.Errorf("set temporary YouTube stream storage tag for %s: %w", temporaryKey, err)
			}
		}
		cdslog.W(w.ctx).Info("AI Clip YouTube merge storage policy applied", zap.String("id", id), zap.String("object_key", key), zap.String("video_key", d.DownloadVideoKey), zap.String("audio_key", d.DownloadAudioKey))
		d.Media.ObjectKey = key
		w.transition("probe")
	case "import":
		d.MediaStatus = "importing"
		if d.Kind == "project" {
			p, err := model.GetOne[model.PrjInfo](w.ctx, model.PrjInfoTableName, model.PrjInfo{ID: d.ProjectID})
			if err != nil {
				return err
			}
			if p == nil || p.DeletedAt != 0 || aiClipHash([]any{p.VideoPath, p.WorkSpacesPath, p.WorkSpaceIndex}) != d.ProjectVersion {
				return aiClipTerminal("SOURCE_CHANGED", "project was changed before its source snapshot was prepared")
			}
			if d.ProjectWorkspace != "" {
				key, err := oss.SharedObjectKey(d.ProjectWorkspace)
				if err != nil {
					return err
				}
				if err := oss.CopyObjectContext(w.ctx, key, clipservice.ObjectKey(id, "workspace.json")); err != nil {
					return err
				}
			}
		}
		if _, err := oss.StatObjectContext(w.ctx, d.UploadKey); err != nil {
			return err
		}
		extension := ".mp4"
		if i := strings.LastIndex(d.UploadKey, "."); i >= 0 && len(d.UploadKey)-i <= 8 {
			extension = strings.ToLower(d.UploadKey[i:])
		}
		key := clipservice.ObjectKey(id, "source"+extension)
		if err := oss.CopyObjectContext(w.ctx, d.UploadKey, key); err != nil {
			return err
		}
		d.Media.ObjectKey = key
		w.transition("probe")
	case "probe":
		d.MediaStatus = "probing"
		status, raw, err := w.mediaTask(func() (int64, error) {
			return clipservice.CreateProbe(w.ctx, d.Media.ObjectKey, clipservice.ObjectKey(id, "cover"), source.UserID)
		})
		if err != nil {
			return err
		}
		if status != "completed" {
			return nil
		}
		media, err := clipservice.ProbeResult(w.ctx, d.Media.ObjectKey, raw)
		if err != nil {
			return err
		}
		d.Media = media
		d.MediaStatus = "ready"
		w.transition("ready")
		w.task.Status = "ready"
	case "transcript":
		d.TranscriptStatus = "preparing"
		var transcript model.AIClipTranscript
		if w.task.ExternalID == "" && d.Kind == "project" && d.ProjectWorkspace != "" {
			var workspace []vo.FrontEndTemplate
			if err := clipservice.ReadJSON(w.ctx, clipservice.ObjectKey(id, "workspace.json"), &workspace); err != nil {
				return err
			}
			if t, err := clipservice.ProjectTranscript(workspace, d.ProjectIndex, d.Media.Duration); err == nil {
				transcript = t
			} else {
				cdslog.W(w.ctx).Warn("AI Clip project transcript requires ASR: "+err.Error(), zap.String("id", id), zap.String("project_id", d.ProjectID), zap.Error(err))
			}
		}
		if len(transcript.Segments) == 0 {
			if w.task.ExternalID == "" {
				client, err := tencent.NewSmartSubtitlesClient(w.ctx)
				if err != nil {
					return err
				}
				taskID, err := client.CreateTask(tencent.SmartSubtitlesSTTReq{AudioPath: oss.JoinPath(d.Media.ObjectKey), SessionContext: "ai_clip:" + id, VideoSrcLanguage: "auto"})
				return w.submitted(taskID, err)
			}
			status, raw, err := tencent.PollSmartSubtitles(w.ctx, w.task.ExternalID)
			if err != nil {
				return err
			}
			if status == "failed" {
				return aiClipTerminal("UPSTREAM_FAILED", "speech recognition failed")
			}
			if status != "completed" {
				return nil
			}
			transcript, err = clipservice.ASRTranscript(raw, d.Media.Duration)
			if err != nil {
				return aiClipTerminal("INVALID_TRANSCRIPT", err.Error(), err)
			}
		}
		key := clipservice.ObjectKey(id, "transcript.json")
		if err := clipservice.StoreJSON(w.ctx, key, transcript); err != nil {
			return err
		}
		d.TranscriptKey = key
		d.TranscriptStatus = "ready"
		d.TranscriptOrigin = transcript.Origin
		w.transition("ready")
		w.task.Status = "ready"
	default:
		return aiClipTerminal("INVALID_TASK", "unknown source stage")
	}
	return nil
}

// cutInput 提交选区裁剪并在本次消费内等待产物。
// 它只在内存保存任务 ID，按普通轮询间隔查询；请求异常或消费取消时返回错误，重投后重新提交。
func (w *aiClipExecution) cutInput(job *model.AIClipJob, source model.AIClipMedia) (string, error) {
	id, err := clipservice.CreateCut(w.ctx, source, job.Data.Settings.AnalysisStart, job.Data.Settings.AnalysisEnd, clipservice.ObjectKey(job.UniqueID, "input"), job.UserID)
	if err != nil {
		return "", err
	}
	if id <= 0 {
		return "", errors.New("missing cut task ID")
	}
	cdslog.W(w.ctx).Info("AI Clip cut submitted", zap.String("job_id", job.UniqueID), zap.Int64("task_id", id))
	for {
		if err := w.ctx.Err(); err != nil {
			return "", err
		}
		status, raw, err := clipservice.QueryMediaTask(w.ctx, id)
		if err != nil {
			return "", err
		}
		switch status {
		case "completed":
			key, err := clipservice.OutputKey(raw)
			if err != nil {
				return "", aiClipTerminal("INVALID_MEDIA", err.Error(), err)
			}
			return key, nil
		case "failed":
			return "", aiClipTerminal("UPSTREAM_FAILED", "media processing failed")
		}
		timer := time.NewTimer(aiClipPollInterval)
		select {
		case <-w.ctx.Done():
			timer.Stop()
			return "", w.ctx.Err()
		case <-timer.C:
		}
	}
}

// jobStep 准备选定区间，执行高光分析并登记候选片段。
// 它在当前消费内完成选区裁剪，随后逐步轮询媒体和算法任务，再校验并排序结果。
func (w *aiClipExecution) jobStep(job *model.AIClipJob, d *model.AIClipJobData) error {
	var source model.AIClipSource
	if err := model.AIClipGetInternal(w.ctx, &source, job.SourceUniqueID); err != nil {
		return err
	}
	if err := clipservice.ReadSourceData(w.ctx, &source); err != nil {
		return err
	}
	s := source.Data
	if w.task.Stage == "source_wait" {
		if source.Status == "failed" && s.MediaStatus != "ready" {
			var cause error
			if source.ErrDetail != "" {
				cause = errors.New(source.ErrDetail)
			}
			return aiClipTerminal("SOURCE_MEDIA_FAILED", "source download or media preparation failed", cause)
		}
		if s.MediaStatus != "ready" {
			if job.PaymentID == "" {
				return aiClipTerminal("INVALID_TASK", "source download requires a paid analysis task")
			}
			// 未扣费时被停放的来源，在已收费任务恢复后只激活和投递一次。
			started, err := model.AIClipActivateSource(w.ctx, source.UniqueID)
			if err != nil {
				return err
			}
			if started {
				aiClipNotify(w.ctx, "source", source.UniqueID)
			}
			return nil
		}
		// 元信息常用整秒，媒体探测保留小数；只校正至多一秒的末端误差，不改变已确认价格。
		fullEnd := d.Settings.AnalysisEnd == d.MetadataDuration
		if !clipservice.Finite(s.Media.Duration) || s.Media.Duration <= d.Settings.AnalysisStart ||
			d.Settings.AnalysisEnd > s.Media.Duration+1 || (fullEnd && math.Abs(s.Media.Duration-d.MetadataDuration) > 1) {
			return aiClipTerminal("SOURCE_CHANGED", "downloaded video duration does not match the selected interval")
		}
		if fullEnd || d.Settings.AnalysisEnd > s.Media.Duration {
			d.Settings.AnalysisEnd = s.Media.Duration
		}
		w.transition("prepare")
		return nil
	}
	if s.MediaStatus != "ready" {
		return aiClipTerminal("SOURCE_CHANGED", "source media is not ready")
	}
	if w.task.Stage == "prepare" || w.task.Stage == "transcript_wait" {
		if s.TranscriptStatus == "failed" {
			var cause error
			if source.ErrDetail != "" {
				cause = errors.New(source.ErrDetail)
			}
			return aiClipTerminal("SOURCE_TRANSCRIPT_FAILED", "source transcription failed", cause)
		}
		if s.TranscriptStatus != "ready" && s.TranscriptStatus != "preparing" && s.TranscriptKey == "" {
			preparing := s
			preparing.TranscriptStatus = "preparing"
			dataPath, err := clipservice.StoreData(w.ctx, source.UniqueID, source.DataPath, preparing)
			if err != nil {
				return err
			}
			started, err := model.AIClipRequestTranscript(w.ctx, source.UniqueID, dataPath)
			if err != nil {
				return err
			}
			if started {
				aiClipNotify(w.ctx, "source", source.UniqueID)
			}
		}
	}
	switch w.task.Stage {
	case "prepare":
		w.task.ExternalID = ""
		if d.Settings.AnalysisStart == 0 && d.Settings.AnalysisEnd == s.Media.Duration {
			d.InputKey = s.Media.ObjectKey
			w.transition("transcript_wait")
			return nil
		}
		key, err := w.cutInput(job, s.Media)
		if err != nil {
			return err
		}
		d.InputKey = key
		w.transition("input_probe")
	case "input_probe":
		status, raw, err := w.mediaTask(func() (int64, error) {
			return clipservice.CreateProbe(w.ctx, d.InputKey, clipservice.ObjectKey(job.UniqueID, "input-cover"), job.UserID)
		})
		if err != nil {
			return err
		}
		if status != "completed" {
			return nil
		}
		m, err := clipservice.ProbeResult(w.ctx, d.InputKey, raw)
		if err != nil {
			return err
		}
		if !clipservice.DurationMatches(m.Duration, d.Settings.AnalysisEnd-d.Settings.AnalysisStart, m.FPS) {
			return aiClipTerminal("INVALID_MEDIA", "cut video duration does not match the selected interval")
		}
		w.transition("transcript_wait")
	case "transcript_wait":
		if s.TranscriptStatus != "ready" {
			return nil
		}
		var full model.AIClipTranscript
		if err := clipservice.ReadJSON(w.ctx, s.TranscriptKey, &full); err != nil {
			return err
		}
		selected := clipservice.SliceTranscript(full, d.Settings.AnalysisStart, d.Settings.AnalysisEnd)
		if len(selected.Segments) == 0 {
			return aiClipTerminal("INVALID_TRANSCRIPT", "selected interval contains no timed speech")
		}
		key := s.TranscriptKey
		// 全选也可能裁掉来源转写末尾的容差，只有内容完全一致时才复用原对象。
		reuseFullTranscript := d.Settings.AnalysisStart == 0 && d.Settings.AnalysisEnd == s.Media.Duration && reflect.DeepEqual(full, selected)
		if !reuseFullTranscript {
			key = clipservice.ObjectKey(job.UniqueID, "input-transcript.json")
			if err := clipservice.StoreJSON(w.ctx, key, selected); err != nil {
				return err
			}
		}
		d.FullTranscriptKey = s.TranscriptKey
		d.InputTranscriptKey = key
		w.transition("analyze")
	case "analyze":
		if w.task.ExternalID == "" {
			var transcript model.AIClipTranscript
			if err := clipservice.ReadJSON(w.ctx, d.InputTranscriptKey, &transcript); err != nil {
				return err
			}
			task, err := highlight.CreateTask(w.ctx, highlight.CreateRequest{VideoURL: oss.ChangeDomainToInternal(oss.JoinPath(d.InputKey)), ASR: clipservice.AlgorithmASR(transcript), Options: highlight.Options{Score: d.ScoreThreshold, AspectRatio: d.Settings.AspectRatio}})
			if err != nil {
				return w.submitted("", err)
			}
			if task == nil {
				return w.submitted("", errors.New("missing task"))
			}
			if err := w.submitted(task.ID, nil); err != nil {
				return err
			}
			d.AlgorithmTaskID = task.ID
			d.AlgorithmStatus = task.Status
			d.AlgorithmProgress = nil
			d.AlgorithmErrorCode = ""
			return nil
		}
		task, err := highlight.QueryTask(w.ctx, w.task.ExternalID)
		if err != nil {
			return err
		}
		d.AlgorithmStatus = task.Status
		d.AlgorithmProgress = task.Progress
		switch task.Status {
		case "queued", "processing":
			return nil
		case "failed":
			d.AlgorithmErrorCode = task.ErrorCode
			if task.ErrorMessage != "" {
				return aiClipTerminal("UPSTREAM_FAILED", "highlight analysis failed", errors.New(task.ErrorMessage))
			}
			return aiClipTerminal("UPSTREAM_FAILED", "highlight analysis failed")
		case "not_found":
			return aiClipTerminal("UPSTREAM_NOT_FOUND", "highlight task does not exist")
		case "completed":
			if len(task.Highlights) > 500 {
				return aiClipTerminal("INVALID_RESULTS", "too many highlight candidates")
			}
			key := clipservice.ObjectKey(job.UniqueID, "algorithm-"+aiClipID()+".json")
			if err := clipservice.StoreJSON(w.ctx, key, task.Highlights); err != nil {
				return err
			}
			d.ResultKey = key
			w.transition("register")
		}
	case "register":
		return w.registerCandidates(job, d)
	case "finalize":
		return w.finalizeCandidates(job, d)
	default:
		return aiClipTerminal("INVALID_TASK", "unknown analysis stage")
	}
	return nil
}

// registerCandidates 校验算法高光结果并创建确定性的候选记录。
// 它从共享 OSS 产物地址提取路径，校验评分和时间范围，并记录无效片段的具体原因。
func (w *aiClipExecution) registerCandidates(job *model.AIClipJob, d *model.AIClipJobData) error {
	var results []highlight.Highlight
	if err := clipservice.ReadJSON(w.ctx, d.ResultKey, &results); err != nil {
		return err
	}
	d.Counts = model.AIClipCounts{Candidates: len(results)}
	var candidates []model.AIClipClip
	var invalidErrors []error
	seen := map[string]bool{}
	for i, h := range results {
		score, scoreErr := clipservice.MapScores(h.Scores)
		// 算法是共用同一 OSS 桶的内网服务，产物地址只提取对象路径，不限制域名。
		key, keyErr := oss.SharedObjectKey(oss.GetOssPath(h.VideoURL))
		var reasons []error
		if scoreErr != nil {
			reasons = append(reasons, fmt.Errorf("score: %w", scoreErr))
		}
		if keyErr != nil {
			reasons = append(reasons, fmt.Errorf("video_url: %w", keyErr))
		}
		for _, field := range []struct{ name, value string }{{"transcript_summary", h.TranscriptSummary}, {"type_zh", h.TypeZH}, {"type_en", h.TypeEN}} {
			if field.value == "" {
				reasons = append(reasons, fmt.Errorf("%s is empty", field.name))
			}
		}
		inputDuration := d.Settings.AnalysisEnd - d.Settings.AnalysisStart
		if !clipservice.Finite(h.Start) || !clipservice.Finite(h.End) || h.Start < 0 || h.End <= h.Start || h.End > inputDuration+.1 {
			reasons = append(reasons, fmt.Errorf("invalid time range: start=%g, end=%g, input_duration=%g", h.Start, h.End, inputDuration))
		}
		if h.ShotID != "" {
			if seen[h.ShotID] {
				reasons = append(reasons, errors.New("duplicate shot_id"))
			}
			seen[h.ShotID] = true
		}
		if len(reasons) > 0 {
			err := fmt.Errorf("candidate[%d] shot_id=%q: %w", i, h.ShotID, errors.Join(reasons...))
			invalidErrors = append(invalidErrors, err)
			cdslog.W(w.ctx).Warn("AI Clip algorithm candidate rejected", zap.String("job_id", job.UniqueID), zap.String("algorithm_task_id", d.AlgorithmTaskID), zap.Int("candidate_index", i), zap.String("shot_id", h.ShotID), zap.Error(err))
			d.Counts.Invalid++
			continue
		}
		id := "hlc_" + strings.ReplaceAll(uuid.NewSHA1(uuid.NameSpaceOID, []byte(job.UniqueID+":"+d.AlgorithmTaskID+":"+strconv.Itoa(i)+":"+h.ShotID)).String(), "-", "")
		candidate := model.AIClipCandidate{ShotID: h.ShotID, Title: h.TranscriptSummary, CategoryZH: h.TypeZH, CategoryEN: h.TypeEN, Score: score, HighlightReason: h.HighlightReason, Start: h.Start, End: h.End, SourceStart: d.Settings.AnalysisStart + h.Start, SourceEnd: d.Settings.AnalysisStart + h.End, Media: model.AIClipMedia{ObjectKey: key, Duration: h.Duration}}
		candidates = append(candidates, model.AIClipClip{UniqueID: id, UserID: job.UserID, SpaceID: job.SpaceID, JobUniqueID: job.UniqueID, Status: "processing", CreateTime: time.Now().Unix(), Data: candidate})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i].Data, candidates[j].Data
		if a.Score.Total != b.Score.Total {
			return a.Score.Total > b.Score.Total
		}
		if a.SourceStart != b.SourceStart {
			return a.SourceStart < b.SourceStart
		}
		return candidates[i].UniqueID < candidates[j].UniqueID
	})
	for i := range candidates {
		c := &candidates[i]
		dataPath, err := clipservice.StoreData(w.ctx, c.UniqueID, "", c.Data)
		if err != nil {
			return err
		}
		c.DataPath = dataPath
		c.Sort = i + 1
	}
	if err := model.BeginCtxTx(w.ctx, func(ctx context.Context) error {
		for i := range candidates {
			if err := model.AIClipCreateCandidate(ctx, &candidates[i]); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if len(results) == 0 {
		d.ResultType = "empty"
		d.EmptyReason = "algorithm_no_highlights"
		w.task.Status = "succeeded"
		w.transition("done")
		return nil
	}
	if len(candidates) == 0 {
		return aiClipTerminal("INVALID_RESULTS", "all algorithm candidates are invalid", fmt.Errorf("algorithm_task_id=%q: %w", d.AlgorithmTaskID, errors.Join(invalidErrors...)))
	}
	w.transition("finalize")
	return nil
}

// finalizeCandidates 探测候选媒体，隔离不可用片段并保存初始编辑结果。
// 它采用探测得到的实际媒体信息，优先排列符合时长偏好的片段，再保留组内评分顺序。
func (w *aiClipExecution) finalizeCandidates(job *model.AIClipJob, d *model.AIClipJobData) error {
	clips, err := model.AIClipAllCandidates(w.ctx, job.UniqueID)
	if err != nil {
		return err
	}
	for i := range clips {
		c := &clips[i]
		if c.Status != "processing" && c.Status != "filtered" {
			continue
		}
		if err := clipservice.ReadData(w.ctx, c.DataPath, &c.Data); err != nil {
			return err
		}
		candidate := c.Data
		save := func(values map[string]any) error {
			return model.BeginCtxTx(w.ctx, func(ctx context.Context) error { return model.AIClipSaveCandidate(ctx, c.UniqueID, values) })
		}
		fail := func(code string, err error) error {
			// 消费取消不代表媒体不可用，交给 MQ 恢复当前候选。
			if w.ctx.Err() != nil {
				return w.ctx.Err()
			}
			cdslog.W(w.ctx).Warn("AI Clip candidate media failed: "+err.Error(), zap.String("job_id", job.UniqueID), zap.String("clip_id", c.UniqueID), zap.Int64("probe_task_id", c.ProbeTaskID), zap.String("code", code), zap.Error(err))
			return model.BeginCtxTx(w.ctx, func(ctx context.Context) error {
				current, lockErr := model.AIClipLockClip(ctx, c.UniqueID)
				if lockErr != nil {
					return lockErr
				}
				if current.Status != "processing" && current.Status != "filtered" {
					return nil
				}
				return model.AIClipSaveCandidate(ctx, c.UniqueID, map[string]any{"status": "failed", "error_code": code})
			})
		}
		if c.ProbeTaskID <= 0 {
			id, err := clipservice.CreateProbe(w.ctx, candidate.Media.ObjectKey, clipservice.ObjectKey(c.UniqueID, "cover"), job.UserID)
			if err != nil {
				return fail("UPSTREAM_FAILED", err)
			}
			if id <= 0 {
				return fail("UPSTREAM_FAILED", errors.New("media probe returned no task ID"))
			}
			return save(map[string]any{"probe_task_id": id})
		}
		status, raw, err := clipservice.QueryMediaTask(w.ctx, c.ProbeTaskID)
		if err != nil {
			return fail("UPSTREAM_FAILED", err)
		}
		if status == "running" {
			continue
		}
		if status == "failed" {
			return fail("UPSTREAM_FAILED", errors.New("candidate media probe failed"))
		}
		m, err := clipservice.ProbeResult(w.ctx, candidate.Media.ObjectKey, raw)
		if err != nil {
			return fail("INVALID_MEDIA", err)
		}
		var input model.AIClipTranscript
		if err := clipservice.ReadJSON(w.ctx, d.InputTranscriptKey, &input); err != nil {
			return err
		}
		candidate.Transcript = clipservice.SliceTranscript(input, candidate.Start, candidate.End)
		candidate.Media = m
		dataPath, err := clipservice.StoreData(w.ctx, c.UniqueID, c.DataPath, candidate)
		if err != nil {
			return err
		}
		return model.BeginCtxTx(w.ctx, func(ctx context.Context) error {
			current, err := model.AIClipLockClip(ctx, c.UniqueID)
			if err != nil {
				return err
			}
			if current.Status != "processing" && current.Status != "filtered" {
				return nil
			}
			editPath := clipservice.ObjectKey(c.UniqueID, "edit.json")
			if err := model.AIClipCompleteCandidate(ctx, c.UniqueID, dataPath, editPath); err != nil {
				return err
			}
			uploadCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			return clipservice.StoreJSON(uploadCtx, editPath, model.AIClipEditData{Media: m, BaseVersion: c.UniqueID, Settings: d.InitialEdit})
		})
	}
	d.Counts.Ready = 0
	d.Counts.Failed = 0
	d.Counts.DurationFiltered = 0
	var ready []model.AIClipClip
	pending := false
	for _, c := range clips {
		switch c.Status {
		case "ready":
			d.Counts.Ready++
			ready = append(ready, c)
		case "failed":
			d.Counts.Failed++
		default:
			pending = true
		}
	}
	if pending {
		return nil
	}
	if d.Counts.Ready == 0 {
		d.ResultType = "empty"
		d.EmptyReason = "all_media_failed"
	} else {
		d.EmptyReason = ""
		d.ResultType = "complete"
		if d.Counts.Failed > 0 || d.Counts.Invalid > 0 {
			d.ResultType = "partial"
		}
		for i := range ready {
			if err := clipservice.ReadData(w.ctx, ready[i].DataPath, &ready[i].Data); err != nil {
				return err
			}
		}
		sort.SliceStable(ready, func(i, j int) bool {
			a, b := ready[i].Data, ready[j].Data
			aMatches := clipservice.MatchesLength(a.Media.Duration, d.Settings.Length)
			bMatches := clipservice.MatchesLength(b.Media.Duration, d.Settings.Length)
			if aMatches != bMatches {
				return aMatches
			}
			if a.Score.Total != b.Score.Total {
				return a.Score.Total > b.Score.Total
			}
			if a.SourceStart != b.SourceStart {
				return a.SourceStart < b.SourceStart
			}
			return ready[i].UniqueID < ready[j].UniqueID
		})
		if err := model.BeginCtxTx(w.ctx, func(ctx context.Context) error {
			for i, c := range ready {
				if err := model.AIClipSaveCandidate(ctx, c.UniqueID, map[string]any{"sort": i + 1}); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	w.task.Status = "succeeded"
	w.transition("done")
	return nil
}

// eraseStep 提交、导入并校验去硬字幕产物。
// 它轮询腾讯 MPS，下载同一存储桶中的 COS 输出，并在完成前校验时间轴和画面尺寸。
func (w *aiClipExecution) eraseStep(task *model.AIClipErase, d *model.AIClipEraseData) error {
	switch w.task.Stage {
	case "erase", "erase_submit":
		if w.task.ExternalID == "" || w.task.Stage == "erase_submit" {
			id, err := tencent.CreateSmartErase(w.ctx, tencent.SmartEraseRequest{InputURL: oss.JoinPath(d.Input.ObjectKey), SessionID: aiClipID(), Bucket: d.OutputBucket, Region: d.OutputRegion, OutputPath: d.OutputPath, Definition: d.Definition})
			if err := w.submitted(id, err); err != nil {
				return err
			}
			w.transition("erase")
			cdslog.W(w.ctx).Info("AI Clip erase submitted", zap.String("id", task.UniqueID), zap.String("external_id", id))
			return nil
		}
		r, err := tencent.PollSmartErase(w.ctx, w.task.ExternalID)
		if err != nil {
			return err
		}
		if r.Status == "failed" {
			return aiClipTerminal("UPSTREAM_FAILED", "hard subtitle removal failed")
		}
		if r.Status != "completed" {
			return nil
		}
		if r.Bucket != d.OutputBucket || r.Region != d.OutputRegion {
			return aiClipTerminal("INVALID_MEDIA", "unexpected SmartErase output storage")
		}
		d.OutputPath = r.Path
		w.transition("erase_import")
	case "erase_import":
		u, err := tencent.SignCOSObject(w.ctx, d.OutputBucket, d.OutputRegion, d.OutputPath)
		if err != nil {
			return err
		}
		key := clipservice.ObjectKey(task.UniqueID, "erased.mp4")
		if _, err := clipservice.DownloadToOSS(w.ctx, u, key, nil, nil); err != nil {
			return err
		}
		d.Result.ObjectKey = key
		w.transition("erase_probe")
	case "erase_probe":
		raw, err := w.eraseProbe(task, d.Result.ObjectKey)
		if err != nil {
			return err
		}
		m, err := clipservice.ProbeResult(w.ctx, d.Result.ObjectKey, raw)
		if err != nil {
			return err
		}
		if !clipservice.DurationMatches(m.Duration, d.Input.Duration, m.FPS) || m.Width != d.Input.Width || m.Height != d.Input.Height {
			return aiClipTerminal("INVALID_MEDIA", "erased video changed the clip timeline or frame")
		}
		d.Result = m
		w.task.Status = "succeeded"
		w.transition("done")
	default:
		return aiClipTerminal("INVALID_TASK", "unknown erase stage")
	}
	return nil
}

// eraseProbe 在本次执行内提交并等待去字幕产物的媒体探测。
// 探测 ID 仅保存在内存和日志中；失败或取消后重新探测，不覆盖腾讯 MPS TaskId。
func (w *aiClipExecution) eraseProbe(task *model.AIClipErase, key string) (json.RawMessage, error) {
	if err := w.ctx.Err(); err != nil {
		return nil, err
	}
	id, err := clipservice.CreateProbe(w.ctx, key, clipservice.ObjectKey(task.UniqueID, "cover"), task.UserID)
	if err != nil {
		return nil, err
	}
	if id <= 0 {
		return nil, errors.New("missing probe task ID")
	}
	cdslog.W(w.ctx).Info("AI Clip erase probe submitted", zap.String("id", task.UniqueID), zap.Int64("task_id", id))
	for {
		if err := w.ctx.Err(); err != nil {
			return nil, err
		}
		status, raw, err := clipservice.QueryMediaTask(w.ctx, id)
		if err != nil {
			return nil, err
		}
		switch status {
		case "completed":
			return raw, nil
		case "failed":
			return nil, aiClipTerminal("UPSTREAM_FAILED", "media processing failed")
		}
		timer := time.NewTimer(aiClipPollInterval)
		select {
		case <-w.ctx.Done():
			timer.Stop()
			return nil, w.ctx.Err()
		case <-timer.C:
		}
	}
}

// exportStep 渲染可选字幕并校验最终导出产物。
// 它确认片段未发生新编辑并读取当前编辑文件，关闭字幕时复用基础媒体，否则轮询渲染和探测。
func (w *aiClipExecution) exportStep(task *model.AIClipExport, d *model.AIClipExportData) error {
	var c model.AIClipClip
	if err := model.AIClipGetInternal(w.ctx, &c, task.UniqueID); err != nil {
		return err
	}
	if c.ExportRevision != task.Revision {
		return nil
	}
	if c.Revision != task.Revision {
		return aiClipTerminal("EDIT_CHANGED", "clip has changed; export the current edit")
	}
	var edit model.AIClipEditData
	if err := clipservice.ReadData(w.ctx, c.EditPath, &edit); err != nil {
		return err
	}
	switch w.task.Stage {
	case "subtitle":
		if !edit.Settings.ShowNewCaptions {
			if _, err := oss.StatObjectContext(w.ctx, edit.Media.ObjectKey); err != nil {
				return err
			}
			d.Result = edit.Media
			w.task.Status = "succeeded"
			w.transition("done")
			return nil
		}
		if err := clipservice.ReadData(w.ctx, c.DataPath, &c.Data); err != nil {
			return err
		}
		node, err := clipservice.SubtitleNode(w.ctx, edit, c.Data.Transcript)
		if err != nil {
			return aiClipTerminal("INVALID_CAPTIONS", err.Error(), err)
		}
		raw, err := node_subtitles.RenderNode(w.ctx, 0, edit.Media.Duration, node)
		if err != nil {
			return err
		}
		key, err := oss.SharedObjectKey(oss.GetOssPath(raw))
		if err != nil {
			return aiClipTerminal("INVALID_MEDIA", "subtitle renderer returned an unexpected object", err)
		}
		d.SubtitleURL = key
		w.transition("render")
	case "render":
		// 合成服务只接受其分配的数字任务 ID，旧版保存的 UUID 在重试时重新申请。
		idNumber, idErr := strconv.ParseInt(w.task.ExternalID, 10, 64)
		if idErr != nil || idNumber <= 0 {
			id, err := render.GetTaskID(w.ctx)
			if err != nil {
				return err
			}
			req, err := clipservice.RenderRequest(w.ctx, id, task.UserID, edit, oss.JoinPath(d.SubtitleURL), clipservice.ObjectKey(task.UniqueID, "export-"+id))
			if err != nil {
				return err
			}
			// 创建失败交给 MQ 重新提交，只有成功创建的任务才进入查询。
			w.task.ExternalID = ""
			if err := render.CreateTask(w.ctx, req); err != nil {
				return err
			}
			w.task.ExternalID = id
			return nil
		}
		r, err := render.GetStatus(w.ctx, w.task.ExternalID)
		if err != nil {
			return err
		}
		if r.TaskID != w.task.ExternalID {
			return errors.New("render task ID mismatch")
		}
		switch r.Status {
		case render.TaskStatusWaiting, render.TaskStatusDoing6, render.TaskStatusDoing:
			return nil
		case render.TaskStatusFailed:
			if r.ErrMsg != "" {
				return aiClipTerminal("UPSTREAM_FAILED", "video composition failed", errors.New(r.ErrMsg))
			}
			return aiClipTerminal("UPSTREAM_FAILED", "video composition failed")
		case render.TaskStatusSuccess:
			key := r.Data.FilePath
			if key == "" {
				key = r.Data.FileUrl
			}
			d.OutputKey, err = oss.SharedObjectKey(oss.GetOssPath(key))
			if err != nil {
				return aiClipTerminal("INVALID_MEDIA", "invalid export object", err)
			}
			w.transition("export_probe")
		default:
			return errors.New("unknown render status")
		}
	case "export_probe":
		status, raw, err := w.mediaTask(func() (int64, error) {
			return clipservice.CreateProbe(w.ctx, d.OutputKey, clipservice.ObjectKey(task.UniqueID, "export-cover-"+strconv.Itoa(task.Revision)), task.UserID)
		})
		if err != nil {
			return err
		}
		if status != "completed" {
			return nil
		}
		m, err := clipservice.ProbeResult(w.ctx, d.OutputKey, raw)
		if err != nil {
			return err
		}
		if !clipservice.DurationMatches(m.Duration, edit.Media.Duration, m.FPS) || m.Width != edit.Media.Width || m.Height != edit.Media.Height {
			return aiClipTerminal("INVALID_MEDIA", "export timeline or dimensions changed")
		}
		d.Result = m
		w.task.Status = "succeeded"
		w.transition("done")
	default:
		return aiClipTerminal("INVALID_TASK", "unknown export stage")
	}
	return nil
}

// RecoverAIClipTasks 为管理接口补投排队或运行中的任务。
// 它仅作为漏投消息的人工修复入口，正常处理和重启恢复由 MQ 消费及重投驱动。
func RecoverAIClipTasks(ctx context.Context) (int, error) {
	count := 0
	for _, kind := range []string{"source", "job", "erase", "export"} {
		ids, err := model.AIClipPendingTasks(ctx, kind, 100)
		if err != nil {
			return count, err
		}
		for _, id := range ids {
			if err := ctx.Err(); err != nil {
				return count, err
			}
			if err := rabbitmq.PublishConfirmed(ctx, config.HighlightQueue(kind), AIClipMessage{Kind: kind, ID: id}); err != nil {
				return count, err
			}
			count++
		}
	}
	return count, nil
}
