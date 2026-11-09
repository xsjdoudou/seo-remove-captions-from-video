package tencent

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	mps "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/mps/v20190612"
	"go.uber.org/zap"

	"podcastor/config"
	"podcastor/constant"
	"podcastor/repository/ossdir"
	"podcastor/repository/vo"
	"podcastor/third_party/ai_platform"
	"podcastor/third_party/aliyun/oss"
	"podcastor/third_party/elevenlabs"
	"podcastor/third_party/errs"
	"podcastor/util"
	"podcastor/util/application"
	"podcastor/util/cdslog"
	"podcastor/util/language"
)

const (
	// defaultRegion 腾讯云 MPS 默认地域，当前复用媒体处理配置且历史未单独传 region。
	defaultRegion = "ap-guangzhou"
	// defaultSampleRate 腾讯云 MPS SyncDubbing 默认采样率，保持与原 ElevenLabs mp3 输出链路一致。
	defaultSampleRate = 24000
	// syncDubbingEngineElevenlabs 腾讯云 MPS 扩展参数 engine，指定使用 ElevenLabs 音色引擎。
	syncDubbingEngineElevenlabs = "elevenlabs"
	// defaultCloneAudioLang 腾讯云 MPS 音色克隆默认音频语言，当前业务克隆样本优先按中文处理。
	defaultCloneAudioLang = "zh"
	// textToSpeechAsyncStatusSuccess 腾讯云异步 TTS 成功状态。
	textToSpeechAsyncStatusSuccess = "success"
	// textToSpeechAsyncStatusFail 腾讯云异步 TTS 失败状态。
	textToSpeechAsyncStatusFail = "fail"
	// textToSpeechAsyncStatusWaiting 腾讯云异步 TTS 排队状态，按中间态处理，允许继续轮询。
	textToSpeechAsyncStatusWaiting = "waiting"
	// textToSpeechAsyncStatusProcessing 腾讯云异步 TTS 处理中状态，实测此状态 ErrorCode=100，允许继续轮询。
	textToSpeechAsyncStatusProcessing = "processing"
	// defaultTextToSpeechAsyncMaxWaitSeconds 腾讯云异步 TTS 默认最长等待时间，1800 秒即 30 分钟。
	defaultTextToSpeechAsyncMaxWaitSeconds = 1800
	// defaultTextToSpeechAsyncPollInterval 腾讯云异步 TTS 默认轮询间隔，缩短到 500ms 以减少异步转同步等待感。
	defaultTextToSpeechAsyncPollInterval = 500 * time.Millisecond
)

type SyncDubbingClient struct {
	ctx    context.Context
	client *mps.Client
}

type SyncDubbingVoiceCloneClient struct {
	syncDubbing *SyncDubbingClient
}

// MPSVoiceCloneProfile 是腾讯云 MPS 创建克隆音色时的可搜索标签画像。
// Labels/Scenes 会进入腾讯云音色库检索维度；调用方应传入项目现有标签体系。
type MPSVoiceCloneProfile struct {
	Name        string
	Description string
	Gender      string
	Age         string
	Languages   []string
	Labels      []string
	Scenes      []string
}

// MPSVoiceInfo 是腾讯云 MPS 音色信息在仓库内使用的稳定结构。
// 外层业务不要直接依赖腾讯云 SDK 的 mps.VoiceInfo，避免 SDK 字段变化扩散到 logic/model/services。
type MPSVoiceInfo struct {
	VoiceID     string
	Name        string
	Description string
	Category    string
	Gender      string
	Age         string
	Languages   []string
	AudioURL    string
	Labels      []string
	Scenes      []string
	RawResponse []byte
}

// NewSyncDubbing 创建腾讯云 MPS SyncDubbing/音色管理客户端。
// 配置约束：复用 tencent.media_process 的 SecretId/SecretKey，region 沿用默认 ap-guangzhou。
func NewSyncDubbing(ctx context.Context) (*SyncDubbingClient, error) {
	if config.Conf.Tencent == nil {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS config is not initialized")
	}
	secretId, secretKey := resolveTencentSecret()
	if secretId == "" || secretKey == "" {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS secret is empty")
	}

	credential := common.NewCredential(secretId, secretKey)
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = "mps.tencentcloudapi.com"
	client, err := mps.NewClient(credential, resolveTencentRegion(), cpf)
	if err != nil {
		cdslog.W(ctx).Error("初始化腾讯云MPS客户端失败", zap.Error(err))
		return nil, err
	}
	return &SyncDubbingClient{ctx: ctx, client: client}, nil
}

// DescribeVoices 查询当前账号可用音色。
// 腾讯云文档：https://cloud.tencent.com/document/product/862/130123
func (c *SyncDubbingClient) DescribeVoices(req *mps.DescribeVoicesRequest) (*mps.DescribeVoicesResponse, error) {
	if c == nil || c.client == nil {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing client is not initialized")
	}
	if req == nil {
		req = mps.NewDescribeVoicesRequest()
	}
	start := time.Now()
	resp, err := c.client.DescribeVoicesWithContext(c.ctx, req)
	mpsLogFinish(c.ctx, "DescribeVoices", start, req, resp, err,
		zap.String("voice_id", tencentString(req.VoiceId)),
		zap.String("request_id", tencentDescribeVoicesRequestID(resp)),
		zap.Int("voice_count", tencentDescribeVoicesCount(resp)),
	)
	return resp, err
}

// GetElevenlabsVoice 按 voiceId 查询腾讯云 MPS ElevenLabs 引擎音色详情。
// 查询不到返回 nil,nil，避免把“腾讯云未收录”误判为系统异常。
func (c *SyncDubbingClient) GetElevenlabsVoice(voiceID string) (*MPSVoiceInfo, error) {
	voiceID = strings.TrimSpace(voiceID)
	if voiceID == "" {
		return nil, nil
	}
	req := mps.NewDescribeVoicesRequest()
	req.VoiceId = common.StringPtr(voiceID)
	req.ExtParam = common.StringPtr(`{"engine":"elevenlabs"}`)
	resp, err := c.DescribeVoices(req)
	if err != nil {
		return nil, err
	}
	if resp == nil || resp.Response == nil {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS DescribeVoices returned empty response")
	}
	if resp.Response.ErrorCode != nil && *resp.Response.ErrorCode != 0 {
		msg := "Tencent MPS DescribeVoices failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		if strings.Contains(strings.ToLower(msg), "not found") {
			return nil, nil
		}
		return nil, errs.NewBusinessErrNoCode(msg)
	}
	for _, voice := range resp.Response.Voices {
		if voice != nil && voice.VoiceId != nil && strings.TrimSpace(*voice.VoiceId) == voiceID {
			return mpsVoiceInfoFromSDK(voice), nil
		}
	}
	return nil, nil
}

// mpsVoiceInfoFromSDK 复制腾讯云音色字段并保留 RawResponse。
// RawResponse 用于后续排查腾讯云新增字段或 labels/scenes/languages 映射差异。
func mpsVoiceInfoFromSDK(voice *mps.VoiceInfo) *MPSVoiceInfo {
	if voice == nil {
		return nil
	}
	raw, _ := json.Marshal(voice)
	return &MPSVoiceInfo{
		VoiceID:     tencentString(voice.VoiceId),
		Name:        tencentString(voice.Name),
		Description: tencentString(voice.Description),
		Category:    tencentString(voice.Category),
		Gender:      tencentString(voice.Gender),
		Age:         tencentString(voice.Age),
		Languages:   tencentStrings(voice.Languages),
		AudioURL:    tencentString(voice.AudioUrl),
		Labels:      tencentStrings(voice.Labels),
		Scenes:      tencentStrings(voice.Scenes),
		RawResponse: raw,
	}
}

// NewMPSVoiceInfoFromCloneProfile 用创建克隆音色时传给腾讯云的画像构造本地元数据。
// 业务注意点：新 clone 的 DescribeVoices 可能有延迟，但 labels/scenes/languages 已经在请求里确定，
// 因此先按实际请求字段落库，后续 DescribeVoices 成功时再用腾讯云返回补全。
func NewMPSVoiceInfoFromCloneProfile(voiceID string, cloneProfile *MPSVoiceCloneProfile) *MPSVoiceInfo {
	voiceID = strings.TrimSpace(voiceID)
	if voiceID == "" {
		return nil
	}
	profile := normalizeMPSVoiceCloneProfile(cloneProfile)
	profile.Name = normalizeSyncDubbingVoiceName(profile.Name)
	raw, _ := json.Marshal(map[string]any{
		"VoiceId":     voiceID,
		"Name":        profile.Name,
		"Description": profile.Description,
		"Category":    "clone",
		"Gender":      profile.Gender,
		"Age":         profile.Age,
		"Languages":   profile.Languages,
		"Labels":      profile.Labels,
		"Scenes":      profile.Scenes,
	})
	return &MPSVoiceInfo{
		VoiceID:     voiceID,
		Name:        profile.Name,
		Description: profile.Description,
		Category:    "clone",
		Gender:      profile.Gender,
		Age:         profile.Age,
		Languages:   profile.Languages,
		Labels:      profile.Labels,
		Scenes:      profile.Scenes,
		RawResponse: raw,
	}
}

// tencentString 安全读取腾讯云 SDK 字符串指针，并去掉首尾空白。
func tencentString(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

// tencentStrings 安全读取腾讯云 SDK 字符串数组指针。
func tencentStrings(values []*string) []string {
	ret := make([]string, 0, len(values))
	for _, value := range values {
		if item := tencentString(value); item != "" {
			ret = append(ret, item)
		}
	}
	return ret
}

// normalizeTencentTaskStatus 统一腾讯云任务状态格式，避免大小写或空白导致状态判断分叉。
func normalizeTencentTaskStatus(status string) string {
	return strings.ToLower(strings.TrimSpace(status))
}

// DeleteVoice 删除当前账号下的腾讯云 MPS 音色槽位。
// 腾讯云文档：https://cloud.tencent.com/document/product/862/130123
// 业务注意点：当前 11labs 迁移流程暂不自动删除腾讯云 clone 槽位，调用方需显式确认后再调用。
func (c *SyncDubbingClient) DeleteVoice(voiceID string) error {
	if c == nil || c.client == nil {
		return errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing client is not initialized")
	}
	voiceID = strings.TrimSpace(voiceID)
	if voiceID == "" {
		return errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing voice id cannot be empty")
	}

	req := mps.NewDeleteVoiceRequest()
	req.VoiceId = common.StringPtr(voiceID)
	// 清槽任务只删除 ElevenLabs 引擎下的 clone，必须与 DescribeVoices 的引擎筛选保持一致。
	req.ExtParam = common.StringPtr(`{"engine":"elevenlabs"}`)
	start := time.Now()
	resp, err := c.client.DeleteVoiceWithContext(c.ctx, req)
	mpsLogFinish(c.ctx, "DeleteVoice", start, req, resp, err,
		zap.String("voice_id", voiceID),
		zap.String("request_id", tencentDeleteVoiceRequestID(resp)),
	)
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS删除音色失败", zap.String("voice_id", voiceID), zap.Error(err))
		return err
	}
	if resp == nil || resp.Response == nil {
		return errs.NewBusinessErrNoCode("Tencent MPS DeleteVoice returned empty response")
	}
	if resp.Response.ErrorCode != nil && *resp.Response.ErrorCode != 0 {
		msg := "Tencent MPS DeleteVoice failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		return errs.NewBusinessErrNoCode(msg)
	}
	return nil
}

// NewSyncDubbingVoiceClone 创建腾讯云 MPS SyncDubbing 音色克隆客户端。
// 腾讯云文档：https://cloud.tencent.com/document/product/862/128038
func NewSyncDubbingVoiceClone(ctx context.Context) (*SyncDubbingVoiceCloneClient, error) {
	client, err := NewSyncDubbing(ctx)
	if err != nil {
		return nil, err
	}
	return &SyncDubbingVoiceCloneClient{syncDubbing: client}, nil
}

// CloneFromOSS 使用 OSS 音频样本在腾讯云 MPS 创建克隆音色。
// 业务注意点：返回的是腾讯云 voiceId，只能写入 voice_migrate_to_id，不能覆盖旧 ElevenLabs lang_id。
func (c *SyncDubbingVoiceCloneClient) CloneFromOSS(voiceName, audioPath string) (string, error) {
	return c.CloneFromOSSWithProfile(audioPath, &MPSVoiceCloneProfile{Name: voiceName})
}

// CloneFromOSSWithProfile 使用 OSS 音频样本和业务标签画像在腾讯云 MPS 创建克隆音色。
// 业务注意点：Labels/Scenes 用于腾讯云音色搜索，只透传调用方提供的内部标签/场景。
func (c *SyncDubbingVoiceCloneClient) CloneFromOSSWithProfile(audioPath string, cloneProfile *MPSVoiceCloneProfile) (string, error) {
	if c == nil || c.syncDubbing == nil || c.syncDubbing.client == nil {
		return "", errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing client is not initialized")
	}
	metaInfo, err := oss.GetObjectMeta(audioPath)
	if err != nil {
		cdslog.W(c.syncDubbing.ctx).Error("获取腾讯云MPS克隆音频元数据失败", zap.String("audio_path", audioPath), zap.Error(err))
		return "", err
	}
	if metaInfo.FileSizeMB > 10 {
		return "", errs.NewBusinessErrNoCode("Voice cloning failed—please ensure the file is under 10 MB.")
	}
	req := mps.NewSyncDubbingRequest()
	// 腾讯云 MPS 服务端需要可公网下载的 AudioUrl；不能传内部签名 URL。
	req.AudioUrl = common.StringPtr(oss.ChangeDomainToExternal(oss.JoinPath(audioPath)))
	profile := normalizeMPSVoiceCloneProfile(cloneProfile)
	req.AudioLang = common.StringPtr(firstMPSProfileLanguage(profile.Languages))
	req.VoiceProfile = &mps.VoiceProfile{
		Name:        common.StringPtr(normalizeSyncDubbingVoiceName(profile.Name)),
		Description: common.StringPtr(profile.Description),
		Gender:      common.StringPtr(profile.Gender),
		Age:         common.StringPtr(profile.Age),
		Languages:   commonStringPtrs(profile.Languages),
		Labels:      commonStringPtrs(profile.Labels),
		Scenes:      commonStringPtrs(profile.Scenes),
	}
	req.ExtParam = common.StringPtr(buildCloneExtParam())

	start := time.Now()
	resp, err := c.syncDubbing.client.SyncDubbingWithContext(c.syncDubbing.ctx, req)
	mpsLogFinish(c.syncDubbing.ctx, "SyncDubbing", start, req, resp, err,
		zap.String("audio_path", audioPath),
		zap.String("request_id", tencentSyncDubbingRequestID(resp)),
		zap.String("voice_id", tencentSyncDubbingVoiceID(resp)),
	)
	if err != nil {
		cdslog.W(c.syncDubbing.ctx).Error("腾讯云MPS同步配音克隆失败", zap.String("audio_path", audioPath), zap.Error(err))
		return "", err
	}
	if resp == nil || resp.Response == nil {
		return "", errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing clone returned empty response")
	}
	if resp.Response.ErrorCode != nil && *resp.Response.ErrorCode != 0 {
		msg := "Tencent MPS SyncDubbing clone failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		return "", errs.NewBusinessErrNoCode(msg)
	}
	if resp.Response.VoiceId == nil || *resp.Response.VoiceId == "" {
		return "", errs.NewBusinessErrNoCode("Tencent MPS SyncDubbing clone returned empty voice id")
	}
	return *resp.Response.VoiceId, nil
}

func normalizeMPSVoiceCloneProfile(profile *MPSVoiceCloneProfile) *MPSVoiceCloneProfile {
	if profile == nil {
		profile = &MPSVoiceCloneProfile{}
	}
	ret := &MPSVoiceCloneProfile{
		Name:        strings.TrimSpace(profile.Name),
		Description: strings.TrimSpace(profile.Description),
		Gender:      strings.ToLower(strings.TrimSpace(profile.Gender)),
		Age:         strings.ToLower(strings.TrimSpace(profile.Age)),
		Languages:   normalizeMPSProfileValues(profile.Languages),
		Labels:      normalizeMPSProfileValues(profile.Labels),
		Scenes:      normalizeMPSProfileValues(profile.Scenes),
	}
	if ret.Name == "" {
		ret.Name = "jogg-clone-voice"
	}
	if ret.Description == "" {
		ret.Description = "Jogg migrated ElevenLabs cloned voice"
	}
	if ret.Gender == "" {
		ret.Gender = "unknown"
	}
	if ret.Age == "" {
		ret.Age = "unknown"
	}
	if len(ret.Languages) == 0 {
		ret.Languages = []string{defaultCloneAudioLang}
	}
	return ret
}

func normalizeMPSProfileValues(values []string) []string {
	ret := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		item := strings.TrimSpace(value)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		ret = append(ret, item)
	}
	return ret
}

func firstMPSProfileLanguage(languages []string) string {
	if len(languages) == 0 || strings.TrimSpace(languages[0]) == "" {
		return defaultCloneAudioLang
	}
	return strings.TrimSpace(languages[0])
}

func commonStringPtrs(values []string) []*string {
	ret := make([]*string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			ret = append(ret, common.StringPtr(value))
		}
	}
	return ret
}

// buildCloneExtParam 组装腾讯云 ElevenLabs 引擎克隆扩展参数。
// 核心注意点：clone 也必须显式传 engine=elevenlabs；否则腾讯云会创建本地 v1_ 音色，
// 该音色不能用 ElevenLabs engine/model 参数合成，和迁移目标不一致。
func buildCloneExtParam() string {
	payload := map[string]any{
		"engine": syncDubbingEngineElevenlabs,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return `{"engine":"elevenlabs"}`
	}
	return string(data)
}

// normalizeSyncDubbingVoiceName 规范腾讯云音色名。
// 腾讯云克隆接口对名称长度更敏感，过长时截断，空名时生成可追踪默认名。
func normalizeSyncDubbingVoiceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "jogg_voice_" + util.GetUUID()[:8]
	}
	if len([]rune(name)) > 20 {
		return string([]rune(name)[:20])
	}
	return name
}

// codecByAudioPath 兼容旧测试保留。
// MPS SyncDubbing 克隆已改为 AudioUrl，不再需要单独传 codec。
func codecByAudioPath(audioPath, defaultCodec string) string {
	// 兼容旧单元测试；MPS SyncDubbing 克隆改为 AudioUrl 后不再需要单独上传 codec 字段。
	if defaultCodec == "" {
		return "wav"
	}
	return fmt.Sprintf("%s", defaultCodec)
}

// resolveTencentSecret 读取腾讯云密钥。
// ElevenLabs 迁移复用 media_process 配置，避免新增 tts/vrs 独立配置。
func resolveTencentSecret() (string, string) {
	if config.Conf.Tencent == nil {
		return "", ""
	}
	if config.Conf.Tencent.MediaProcess != nil {
		return config.Conf.Tencent.MediaProcess.SecretId, config.Conf.Tencent.MediaProcess.SecretKey
	}
	return "", ""
}

// resolveTencentRegion 读取腾讯云地域。
// 历史 MPS/Sora 代码使用 Sora.Region；为空时回到默认广州地域。
func resolveTencentRegion() string {
	if config.Conf.Tencent != nil && config.Conf.Tencent.Sora != nil && config.Conf.Tencent.Sora.Region != "" {
		return config.Conf.Tencent.Sora.Region
	}
	return defaultRegion
}

// Synthesize 通过腾讯云 MPS TextToSpeechAsync 异步语音合成接口做 TTS。
// 腾讯云文档：https://cloud.tencent.com/document/product/862/130944
// 输入/输出约束：req.VoiceId 必须是 adapter 转换后的腾讯云 voiceId，返回会转换为 vo.TTSBySDKRespData。
func (c *SyncDubbingClient) Synthesize(req *vo.TTSBySDKReq, lang *language.Language) (*vo.TTSBySDKRespData, error) {
	if req == nil || strings.TrimSpace(req.Text) == "" {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync text cannot be empty")
	}
	if strings.TrimSpace(req.VoiceId) == "" {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync voice id cannot be empty")
	}

	asyncReq := mps.NewTextToSpeechAsyncRequest()
	asyncReq.Text = common.StringPtr(req.Text)
	asyncReq.TextLang = common.StringPtr(syncDubbingLang(lang))
	asyncReq.VoiceId = common.StringPtr(strings.TrimSpace(req.VoiceId))
	extParam, err := json.Marshal(SyncDubbingExtParamMap(req))
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS ExtParam序列化失败", zap.Error(err), zap.String("voice_id", req.VoiceId))
		return nil, err
	}
	asyncReq.ExtParam = common.StringPtr(string(extParam))

	totalStart := time.Now()
	createStart := time.Now()
	createResp, err := c.client.TextToSpeechAsyncWithContext(c.ctx, asyncReq)
	mpsLogFinish(c.ctx, "TextToSpeechAsync", createStart, asyncReq, createResp, err,
		zap.String("voice_id", strings.TrimSpace(req.VoiceId)),
		zap.String("request_id", tencentTextToSpeechCreateRequestID(createResp)),
		zap.String("task_id", tencentTextToSpeechCreateTaskID(createResp)),
	)
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS提交失败", zap.Error(err), zap.String("voice_id", req.VoiceId))
		return nil, err
	}
	if err = validateTextToSpeechAsyncCreateResponse(createResp); err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS提交响应异常", zap.Error(err), zap.String("voice_id", req.VoiceId))
		return nil, err
	}
	resultResp, err := c.waitTextToSpeechAsyncTask(*createResp.Response.TaskId)
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS查询失败", zap.Error(err), zap.String("voice_id", req.VoiceId), zap.String("task_id", *createResp.Response.TaskId))
		return nil, err
	}
	cdslog.W(c.ctx).Info("腾讯云MPS异步TTS任务完成",
		zap.String("trace_id", application.GetTraceId(c.ctx)),
		zap.String("action", "TextToSpeechAsync.total"),
		zap.String("cost", time.Since(totalStart).String()),
		zap.String("voice_id", strings.TrimSpace(req.VoiceId)),
		zap.String("task_id", *createResp.Response.TaskId),
		zap.String("request_id", tencentTextToSpeechTaskRequestID(resultResp)),
		zap.String("status", tencentTextToSpeechTaskStatus(resultResp)),
	)
	return c.toRespData(req, resultResp.Response, lang)
}

// validateTextToSpeechAsyncCreateResponse 校验腾讯云异步 TTS 提交响应。
// 只有 ErrorCode 为 0 且 TaskId 非空才认为任务提交成功。
func validateTextToSpeechAsyncCreateResponse(resp *mps.TextToSpeechAsyncResponse) error {
	if resp == nil || resp.Response == nil {
		return errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync returned empty response")
	}
	if resp.Response.ErrorCode != nil && *resp.Response.ErrorCode != 0 {
		msg := "Tencent MPS TextToSpeechAsync failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		return errs.NewBusinessErrNoCode(msg)
	}
	if resp.Response.TaskId == nil || strings.TrimSpace(*resp.Response.TaskId) == "" {
		return errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync returned empty task id")
	}
	return nil
}

// waitTextToSpeechAsyncTask 轮询腾讯云异步 TTS 任务。
// 调用方仍需要同步拿到原 ElevenLabs 返回结构，因此在 adapter 内等待任务结束。
func (c *SyncDubbingClient) waitTextToSpeechAsyncTask(taskID string) (*mps.DescribeTextToSpeechAsyncTaskResponse, error) {
	deadline := time.Now().Add(defaultTextToSpeechAsyncMaxWaitSeconds * time.Second)
	for {
		queryReq := mps.NewDescribeTextToSpeechAsyncTaskRequest()
		queryReq.TaskId = common.StringPtr(taskID)
		start := time.Now()
		resp, err := c.client.DescribeTextToSpeechAsyncTaskWithContext(c.ctx, queryReq)
		mpsLogFinish(c.ctx, "DescribeTextToSpeechAsyncTask", start, queryReq, resp, err,
			zap.String("task_id", taskID),
			zap.String("request_id", tencentTextToSpeechTaskRequestID(resp)),
			zap.String("status", tencentTextToSpeechTaskStatus(resp)),
		)
		if err != nil {
			return nil, err
		}
		if err = validateTextToSpeechAsyncTaskResponse(resp); err != nil {
			return nil, err
		}
		status := normalizeTencentTaskStatus(tencentString(resp.Response.Status))
		switch status {
		case textToSpeechAsyncStatusSuccess:
			return resp, nil
		case textToSpeechAsyncStatusWaiting, textToSpeechAsyncStatusProcessing:
		default:
			return resp, errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync task abnormal status: " + status)
		}
		if time.Now().After(deadline) {
			return nil, errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync task timeout")
		}
		timer := time.NewTimer(defaultTextToSpeechAsyncPollInterval)
		select {
		case <-c.ctx.Done():
			timer.Stop()
			return nil, c.ctx.Err()
		case <-timer.C:
		}
	}
}

// validateTextToSpeechAsyncTaskResponse 校验腾讯云异步 TTS 查询响应。
// 核心注意点：腾讯云 processing 状态会返回 ErrorCode=100，这不是失败，必须继续轮询；
// success 必须带 AudioUrl；fail 或非 processing 的非 0 ErrorCode 才返回业务错误。
func validateTextToSpeechAsyncTaskResponse(resp *mps.DescribeTextToSpeechAsyncTaskResponse) error {
	if resp == nil || resp.Response == nil {
		return errs.NewBusinessErrNoCode("Tencent MPS DescribeTextToSpeechAsyncTask returned empty response")
	}
	status := strings.ToLower(strings.TrimSpace(tencentString(resp.Response.Status)))
	if status == textToSpeechAsyncStatusWaiting || status == textToSpeechAsyncStatusProcessing {
		return nil
	}
	if resp.Response.ErrorCode != nil && *resp.Response.ErrorCode != 0 {
		msg := "Tencent MPS DescribeTextToSpeechAsyncTask failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		return errs.NewBusinessErrNoCode(msg)
	}
	switch status {
	case textToSpeechAsyncStatusSuccess:
		if resp.Response.AudioUrl == nil || strings.TrimSpace(*resp.Response.AudioUrl) == "" {
			return errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync task returned empty audio url")
		}
		return nil
	case textToSpeechAsyncStatusFail:
		msg := "Tencent MPS TextToSpeechAsync task failed"
		if resp.Response.Msg != nil && *resp.Response.Msg != "" {
			msg = *resp.Response.Msg
		}
		return errs.NewBusinessErrNoCode(msg)
	default:
		return errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync task abnormal status: " + status)
	}
}

// toRespData 将腾讯云音频和 ExtInfo 转成原 TTS 返回结构。
// 音频先落 OSS；若产物路径为 mp3，则按现有下游约定转 wav。
func (c *SyncDubbingClient) toRespData(req *vo.TTSBySDKReq, response *mps.DescribeTextToSpeechAsyncTaskResponseParams, lang *language.Language) (*vo.TTSBySDKRespData, error) {
	var ossResp *vo.UploadResponse
	var err error
	projectID := ""
	var replacements []vo.PhoneticScript
	if req != nil {
		projectID = req.ProjectID
		replacements = req.Replacements
	}
	if projectID != "" {
		ossResp, err = uploadTencentTTSURL(response.AudioUrl, projectID)
	} else {
		ossResp, err = uploadTencentTTSURL(response.AudioUrl, "")
	}
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS上传音频失败", zap.Error(err))
		return nil, err
	}

	if ossResp != nil && strings.Contains(path.Ext(ossResp.FullPath), constant.AudioMp3Type) {
		ossResp.FullPath, err = ai_platform.Audio2Wav(c.ctx, ai_platform.Audio2WavReq{
			Path:       ossResp.FullPath,
			OutputPath: path.Dir(ossResp.Path),
		}, fmt.Sprintf("%d", time.Now().Unix()))
		u, _ := url.Parse(ossResp.FullPath)
		ossResp.Path = u.Path
	}
	if err != nil {
		cdslog.W(c.ctx).Error("腾讯云MPS异步TTS音频转换失败", zap.Error(err))
		return nil, err
	}

	var extInfo string
	var words []*vo.WordBoundary
	if response.ExtInfo != nil && strings.TrimSpace(*response.ExtInfo) != "" {
		var tencentExt tencentSyncDubbingExtInfo
		if json.Unmarshal([]byte(*response.ExtInfo), &tencentExt) == nil &&
			len(tencentExt.EngineExt.Alignment.Characters) > 0 &&
			len(tencentExt.EngineExt.Alignment.Characters) == len(tencentExt.EngineExt.Alignment.CharacterStartTimesSeconds) &&
			len(tencentExt.EngineExt.Alignment.Characters) == len(tencentExt.EngineExt.Alignment.CharacterEndTimesSeconds) {
			withTimeResp := elevenlabs.TTSWithTimeResp{
				Alignment:           tencentExt.EngineExt.Alignment,
				NormalizedAlignment: tencentExt.EngineExt.NormalizedAlignment,
			}
			if len(withTimeResp.NormalizedAlignment.Characters) == 0 {
				withTimeResp.NormalizedAlignment = withTimeResp.Alignment
			}
			syncDubbingApplyPhoneticReplacements(&withTimeResp.Alignment, replacements)
			syncDubbingRemoveBreakTags(&withTimeResp.Alignment)
			words = syncDubbingAlignmentToWords(withTimeResp.Alignment, lang)

			if data, marshalErr := json.Marshal(struct {
				Alignment           elevenlabs.Alignment `json:"alignment"`
				NormalizedAlignment elevenlabs.Alignment `json:"normalized_alignment"`
			}{
				Alignment:           withTimeResp.Alignment,
				NormalizedAlignment: withTimeResp.NormalizedAlignment,
			}); marshalErr == nil {
				extInfo = string(data)
			}
		}
	}

	return &vo.TTSBySDKRespData{
		Audio:   ossResp,
		Words:   words,
		ExtInfo: extInfo,
	}, nil
}

// uploadTencentTTSURL 下载腾讯云异步 TTS 产物并上传到我方 OSS。
// 腾讯云返回 AudioUrl 有有效期，业务侧仍保存我方 OSS 地址。
func uploadTencentTTSURL(audioURL *string, projectID string) (*vo.UploadResponse, error) {
	if audioURL == nil || strings.TrimSpace(*audioURL) == "" {
		return nil, errs.NewBusinessErrNoCode("Tencent MPS TextToSpeechAsync audio url is empty")
	}
	ext := constant.AudioMp3Type
	if parsed, err := url.Parse(*audioURL); err == nil {
		if parsedExt := path.Ext(parsed.Path); parsedExt != "" {
			ext = parsedExt
		}
	}
	if projectID != "" {
		return oss.UploadFileByUrlAndExt(*audioURL, ext, ossdir.GetProjectTTS(projectID))
	}
	return oss.UploadFileByUrlAndExt(*audioURL, ext)
}

// SyncDubbingExtParamMap 返回结构化 ExtParam，主要用于资源日志。
func SyncDubbingExtParamMap(req *vo.TTSBySDKReq) map[string]any {
	modelID := elevenlabs.ElevenlabsModelIdFlashV2_5
	settings := map[string]any{
		"similarity_boost":  0.9,
		"stability":         0.5,
		"style":             0.0,
		"use_speaker_boost": true,
		"speed":             1.0,
	}
	engineCustom := map[string]any{"voice_settings": settings}

	if req != nil && req.TtsAttributes != nil {
		for _, supportModelID := range elevenlabs.ElevenlabsSupportModelIdList {
			if req.TtsAttributes.ModelId == supportModelID {
				modelID = req.TtsAttributes.ModelId
				break
			}
		}
		if req.TtsAttributes.Similarity >= 0 && req.TtsAttributes.Similarity <= 1 {
			settings["similarity_boost"] = req.TtsAttributes.Similarity
		}
		if req.TtsAttributes.Stability >= 0 && req.TtsAttributes.Stability <= 1 {
			settings["stability"] = req.TtsAttributes.Stability
		}
		if req.TtsAttributes.StyleExaggeration >= 0 && req.TtsAttributes.StyleExaggeration <= 1 {
			settings["style"] = req.TtsAttributes.StyleExaggeration
		}
		settings["use_speaker_boost"] = req.TtsAttributes.SpeakerBoost
	}
	if modelID == elevenlabs.ElevenlabsModelIdV3 {
		settings["similarity_boost"] = 0.75
		settings["stability"] = 0.5
		settings["style"] = 0.0
		settings["use_speaker_boost"] = true
	} else if req != nil {
		if previousText := strings.TrimSpace(req.PreviousText); previousText != "" {
			engineCustom["previous_text"] = previousText
		}
		if nextText := strings.TrimSpace(req.NextText); nextText != "" {
			engineCustom["next_text"] = nextText
		}
	}
	if req != nil && req.WithTimestamps {
		engineCustom["with_timestamps"] = true
	}

	synExt := map[string]any{
		"model":        modelID,
		"sampleRate":   defaultSampleRate,
		"engineCustom": engineCustom,
	}
	return map[string]any{
		"engine": syncDubbingEngineElevenlabs,
		"synExt": synExt,
	}
}

// SyncDubbingTextLang 返回腾讯云 TextLang 参数。
func SyncDubbingTextLang(lang *language.Language) string {
	return syncDubbingLang(lang)
}

type tencentSyncDubbingExtInfo struct {
	SubtitleItems []struct {
		Words []struct {
			Text      string  `json:"text"`
			StartTime float64 `json:"startTime"`
			EndTime   float64 `json:"endTime"`
		} `json:"words"`
	} `json:"subtitleItems"`
	EngineExt struct {
		Alignment           elevenlabs.Alignment `json:"alignment"`
		NormalizedAlignment elevenlabs.Alignment `json:"normalized_alignment"`
	} `json:"engineExt"`
}

// syncDubbingLang 将内部语言结构转换为腾讯云 TextLang。
func syncDubbingLang(lang *language.Language) string {
	if lang == nil {
		return "zh"
	}
	langCode := strings.TrimSpace(lang.LangCode)
	if langCode != "" {
		return normalizeTencentLangCode(langCode)
	}
	return normalizeTencentLangCode(lang.Lang)
}

// normalizeTencentLangCode 规范腾讯云语言编码。
// 腾讯云文档的国家/语言编码与项目内部编码不完全一致，这里只做必要兼容转换。
func normalizeTencentLangCode(code string) string {
	code = strings.TrimSpace(strings.ToLower(code))
	if code == "" {
		return "zh"
	}
	switch code {
	case "zh", "zh-cn", "chinese":
		return "zh"
	case "en", "en-us", "en-gb", constant.LanguageEn:
		return "en"
	case "ja", "jp", "japanese":
		return "ja"
	case "ko", "kr", "korean":
		return "ko"
	case "pt-br", "pt-pt":
		return "pt"
	case "zh-tw", "yue":
		return "yue"
	default:
		if idx := strings.Index(code, "-"); idx > 0 {
			return code[:idx]
		}
		return code
	}
}

// syncDubbingExtInfoToWords 按 master-prod ElevenLabs toRespData 规则从 ExtInfo.engineExt.alignment 生成业务 Words。
// alignment 中保留空格；业务 Words 里空格只切词不返回，标点跟随所在词。
func syncDubbingExtInfoToWords(extInfo *string, lang *language.Language) []*vo.WordBoundary {
	if extInfo == nil || strings.TrimSpace(*extInfo) == "" {
		return nil
	}
	var tencentExt tencentSyncDubbingExtInfo
	if err := json.Unmarshal([]byte(*extInfo), &tencentExt); err != nil {
		return nil
	}
	alignment := tencentExt.EngineExt.Alignment
	if len(alignment.Characters) == 0 ||
		len(alignment.Characters) != len(alignment.CharacterStartTimesSeconds) ||
		len(alignment.Characters) != len(alignment.CharacterEndTimesSeconds) {
		return nil
	}
	if lang == nil {
		lang = &language.Language{IsSpaceDelimiter: true}
	}
	return syncDubbingAlignmentToWords(alignment, lang)
}

// syncDubbingAlignmentToWords 按 ElevenLabs 原 toRespData 规则从字符级 alignment 生成业务 Words。
func syncDubbingAlignmentToWords(alignment elevenlabs.Alignment, lang *language.Language) []*vo.WordBoundary {
	if len(alignment.Characters) == 0 ||
		len(alignment.Characters) != len(alignment.CharacterStartTimesSeconds) ||
		len(alignment.Characters) != len(alignment.CharacterEndTimesSeconds) {
		return nil
	}
	if lang == nil {
		lang = &language.Language{IsSpaceDelimiter: true}
	}
	words := make([]*vo.WordBoundary, len(alignment.Characters))
	var wordIndex int
	for i := 0; i < len(alignment.Characters); i++ {
		if lang.IsSpaceDelimiter && alignment.Characters[i] == " " {
			wordIndex++
			continue
		} else if !lang.IsSpaceDelimiter && i != 0 {
			wordIndex++
		}
		if words[wordIndex] == nil {
			words[wordIndex] = &vo.WordBoundary{AudioOffset: int(alignment.CharacterStartTimesSeconds[i] * 1000)}
		}
		words[wordIndex].Text += alignment.Characters[i]
		words[wordIndex].Duration += int((alignment.CharacterEndTimesSeconds[i] - alignment.CharacterStartTimesSeconds[i]) * 1000)
	}
	if len(words) == 0 || words[0] == nil {
		return nil
	}
	if wordIndex >= len(words) || words[wordIndex] == nil {
		wordIndex--
	}
	return words[:wordIndex+1]
}

// syncDubbingApplyPhoneticReplacements 按 ElevenLabs 原逻辑把注音替换回展示文本。
func syncDubbingApplyPhoneticReplacements(alignment *elevenlabs.Alignment, replacements []vo.PhoneticScript) {
	if alignment == nil || len(replacements) == 0 || len(alignment.Characters) == 0 {
		return
	}
	offset := 0
	for _, replacement := range replacements {
		replacement.IndexStart += offset
		replacement.IndexEnd += offset
		if replacement.Script == "" {
			continue
		}
		replaceCharacters := strings.Split(replacement.Script, "")
		if replacement.IndexStart < 0 || replacement.IndexEnd > len(alignment.Characters) || replacement.IndexStart >= replacement.IndexEnd {
			continue
		}

		replaceStartTimesSeconds, replaceEndTimesSeconds := syncDubbingReplacementTimes(alignment, replacement, len(replaceCharacters))
		if len(replaceStartTimesSeconds) != len(replaceCharacters) || len(replaceEndTimesSeconds) != len(replaceCharacters) {
			continue
		}
		if replacement.IndexEnd == len(alignment.Characters) {
			alignment.Characters = append(alignment.Characters[:replacement.IndexStart], replaceCharacters...)
			alignment.CharacterStartTimesSeconds = append(alignment.CharacterStartTimesSeconds[:replacement.IndexStart], replaceStartTimesSeconds...)
			alignment.CharacterEndTimesSeconds = append(alignment.CharacterEndTimesSeconds[:replacement.IndexStart], replaceEndTimesSeconds...)
		} else {
			alignment.Characters = append(alignment.Characters[:replacement.IndexStart],
				append(replaceCharacters, alignment.Characters[replacement.IndexEnd:]...)...)
			alignment.CharacterStartTimesSeconds = append(alignment.CharacterStartTimesSeconds[:replacement.IndexStart],
				append(replaceStartTimesSeconds, alignment.CharacterStartTimesSeconds[replacement.IndexEnd:]...)...)
			alignment.CharacterEndTimesSeconds = append(alignment.CharacterEndTimesSeconds[:replacement.IndexStart],
				append(replaceEndTimesSeconds, alignment.CharacterEndTimesSeconds[replacement.IndexEnd:]...)...)
		}
		offset += utf8.RuneCountInString(replacement.Script) - utf8.RuneCountInString(replacement.NewScript)
	}
}

// syncDubbingReplacementTimes 将被替换片段的时间平均分配给新字符。
func syncDubbingReplacementTimes(alignment *elevenlabs.Alignment, replacement vo.PhoneticScript, charCount int) ([]float64, []float64) {
	if alignment == nil || charCount <= 0 {
		return nil, nil
	}
	timeEndIndex := replacement.IndexEnd
	if replacement.IndexEnd == len(alignment.Characters) {
		timeEndIndex = replacement.IndexEnd - 1
	}
	if replacement.IndexStart < 0 || timeEndIndex < 0 ||
		replacement.IndexStart >= len(alignment.CharacterStartTimesSeconds) ||
		timeEndIndex >= len(alignment.CharacterStartTimesSeconds) ||
		replacement.IndexStart >= len(alignment.CharacterEndTimesSeconds) ||
		timeEndIndex >= len(alignment.CharacterEndTimesSeconds) {
		return nil, nil
	}

	startTimeDiff := new(big.Float).Sub(big.NewFloat(alignment.CharacterStartTimesSeconds[timeEndIndex]),
		big.NewFloat(alignment.CharacterStartTimesSeconds[replacement.IndexStart]))
	startTimeAvg := new(big.Float).Quo(startTimeDiff, big.NewFloat(float64(charCount)))
	endTimeDiff := alignment.CharacterEndTimesSeconds[timeEndIndex] - alignment.CharacterEndTimesSeconds[replacement.IndexStart]
	endTimeAvg := new(big.Float).Quo(big.NewFloat(endTimeDiff), big.NewFloat(float64(charCount)))

	replaceStartTimesSeconds := make([]float64, 0, charCount)
	replaceEndTimesSeconds := make([]float64, 0, charCount)
	for i := 0; i < charCount; i++ {
		startTimeProduct := new(big.Float).Mul(startTimeAvg, big.NewFloat(float64(i)))
		startTime, _ := new(big.Float).Add(big.NewFloat(alignment.CharacterStartTimesSeconds[replacement.IndexStart]), startTimeProduct).Float64()
		replaceStartTimesSeconds = append(replaceStartTimesSeconds, startTime)

		endTimeProduct := new(big.Float).Mul(endTimeAvg, big.NewFloat(float64(i)))
		endTime, _ := new(big.Float).Add(big.NewFloat(alignment.CharacterEndTimesSeconds[replacement.IndexStart]), endTimeProduct).Float64()
		replaceEndTimesSeconds = append(replaceEndTimesSeconds, endTime)
	}
	return replaceStartTimesSeconds, replaceEndTimesSeconds
}

// syncDubbingRemoveBreakTags 去除 <break time="..."/> 片段，保持和 ElevenLabs 原转换一致。
func syncDubbingRemoveBreakTags(alignment *elevenlabs.Alignment) {
	if alignment == nil || len(alignment.Characters) == 0 {
		return
	}
	removeIndex := util.FindBreakIndex(alignment.Characters)
	if len(removeIndex) == 0 {
		return
	}
	newCharacters := make([]string, 0, len(alignment.Characters))
	newStarts := make([]float64, 0, len(alignment.CharacterStartTimesSeconds))
	newEnds := make([]float64, 0, len(alignment.CharacterEndTimesSeconds))
	lastEnd := 0
	for i, r := range removeIndex {
		if i == 0 {
			newCharacters = append(newCharacters, alignment.Characters[:r[0]]...)
			newStarts = append(newStarts, alignment.CharacterStartTimesSeconds[:r[0]]...)
			newEnds = append(newEnds, alignment.CharacterEndTimesSeconds[:r[0]]...)
		} else {
			newCharacters = append(newCharacters, alignment.Characters[lastEnd:r[0]]...)
			newStarts = append(newStarts, alignment.CharacterStartTimesSeconds[lastEnd:r[0]]...)
			newEnds = append(newEnds, alignment.CharacterEndTimesSeconds[lastEnd:r[0]]...)
		}
		lastEnd = r[1]
		if i == len(removeIndex)-1 {
			newCharacters = append(newCharacters, alignment.Characters[r[1]:]...)
			newStarts = append(newStarts, alignment.CharacterStartTimesSeconds[r[1]:]...)
			newEnds = append(newEnds, alignment.CharacterEndTimesSeconds[r[1]:]...)
		}
	}
	alignment.Characters = newCharacters
	alignment.CharacterStartTimesSeconds = newStarts
	alignment.CharacterEndTimesSeconds = newEnds
}

func tencentDescribeVoicesRequestID(resp *mps.DescribeVoicesResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.RequestId)
}

func tencentDescribeVoicesCount(resp *mps.DescribeVoicesResponse) int {
	if resp == nil || resp.Response == nil || resp.Response.TotalCount == nil {
		return 0
	}
	return int(*resp.Response.TotalCount)
}

func tencentDeleteVoiceRequestID(resp *mps.DeleteVoiceResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.RequestId)
}

func tencentSyncDubbingRequestID(resp *mps.SyncDubbingResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.RequestId)
}

func tencentSyncDubbingVoiceID(resp *mps.SyncDubbingResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.VoiceId)
}

func tencentTextToSpeechCreateRequestID(resp *mps.TextToSpeechAsyncResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.RequestId)
}

func tencentTextToSpeechCreateTaskID(resp *mps.TextToSpeechAsyncResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.TaskId)
}

func tencentTextToSpeechTaskRequestID(resp *mps.DescribeTextToSpeechAsyncTaskResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.RequestId)
}

func tencentTextToSpeechTaskStatus(resp *mps.DescribeTextToSpeechAsyncTaskResponse) string {
	if resp == nil || resp.Response == nil {
		return ""
	}
	return tencentString(resp.Response.Status)
}
