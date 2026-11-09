package tencent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	mps "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/mps/v20190612"
	cos "github.com/tencentyun/cos-go-sdk-v5"
	"go.uber.org/zap"
	"podcastor/util/cdslog"
)

type SmartEraseRequest struct {
	InputURL, SessionID, Bucket, Region, OutputPath string
	Definition                                      uint64
}
type SmartEraseResult struct{ Status, Path, Bucket, Region string }

// CreateSmartErase 提交腾讯 MPS 去硬字幕任务。
// 它校验输出存储配置，构造 SmartErase 工作流请求，并返回任务 ID 或原始 SDK 错误。
func CreateSmartErase(ctx context.Context, input SmartEraseRequest) (string, error) {
	c, err := NewSyncDubbing(ctx)
	if err != nil {
		return "", err
	}
	if input.Definition == 0 || input.Definition > 1<<63-1 || input.Bucket == "" || input.Region == "" || input.SessionID == "" {
		return "", errors.New("incomplete SmartErase configuration")
	}
	req := mps.NewProcessMediaRequest()
	req.InputInfo = &mps.MediaInputInfo{Type: common.StringPtr("URL"), UrlInputInfo: &mps.UrlInputInfo{Url: common.StringPtr(input.InputURL)}}
	req.OutputStorage = &mps.TaskOutputStorage{Type: common.StringPtr("COS"), CosOutputStorage: &mps.CosOutputStorage{Bucket: common.StringPtr(input.Bucket), Region: common.StringPtr(input.Region)}}
	req.OutputDir = common.StringPtr("/")
	req.SessionId = common.StringPtr(input.SessionID)
	req.SessionContext = common.StringPtr(input.SessionID)
	req.SmartEraseTask = &mps.SmartEraseTaskInput{Definition: common.Int64Ptr(int64(input.Definition)), OutputObjectPath: common.StringPtr(input.OutputPath)}
	resp, err := c.client.ProcessMediaWithContext(ctx, req)
	if err != nil {
		return "", err
	}
	if resp == nil || resp.Response == nil || tencentString(resp.Response.TaskId) == "" {
		return "", errors.New("SmartErase returned no task ID")
	}
	return *resp.Response.TaskId, nil
}

// PollSmartErase 查询一个腾讯 SmartErase 任务。
// 它保留原始 SDK 错误，区分任务状态，并校验返回的 COS 存储信息。
func PollSmartErase(ctx context.Context, taskID string) (*SmartEraseResult, error) {
	c, err := NewSyncDubbing(ctx)
	if err != nil {
		return nil, err
	}
	req := mps.NewDescribeTaskDetailRequest()
	req.TaskId = common.StringPtr(taskID)
	r, err := c.client.DescribeTaskDetailWithContext(ctx, req)
	if err != nil {
		return nil, err
	}
	if r == nil || r.Response == nil {
		return nil, errors.New("SmartErase response is empty")
	}
	status := tencentString(r.Response.Status)
	w := r.Response.WorkflowTask
	if w != nil && ((w.ErrCode != nil && *w.ErrCode != 0) || (w.SmartEraseTaskResult != nil && (tencentString(w.SmartEraseTaskResult.Status) == "FAIL" || tencentString(w.SmartEraseTaskResult.ErrCodeExt) != ""))) {
		var code int64
		if w.ErrCode != nil {
			code = *w.ErrCode
		}
		err := fmt.Errorf("SmartErase workflow failed: code=%d message=%s", code, tencentString(w.Message))
		if result := w.SmartEraseTaskResult; result != nil {
			err = fmt.Errorf("%w; erase status=%s code=%s message=%s", err, tencentString(result.Status), tencentString(result.ErrCodeExt), tencentString(result.Message))
		}
		cdslog.W(ctx).Warn("AI Clip subtitle erasure failed: "+err.Error(), zap.String("task_id", taskID), zap.Error(err))
		return &SmartEraseResult{Status: "failed"}, nil
	}
	if status == "WAITING" || status == "PROCESSING" {
		return &SmartEraseResult{Status: "running"}, nil
	}
	if status != "FINISH" {
		return nil, errors.New("unknown SmartErase status")
	}
	if w == nil || w.SmartEraseTaskResult == nil || tencentString(w.SmartEraseTaskResult.Status) != "SUCCESS" || w.SmartEraseTaskResult.Output == nil {
		err := errors.New("SmartErase finished without a successful output")
		cdslog.W(ctx).Warn("AI Clip subtitle erasure failed: "+err.Error(), zap.String("task_id", taskID), zap.Error(err))
		return &SmartEraseResult{Status: "failed"}, nil
	}
	o := w.SmartEraseTaskResult.Output
	if o.OutputStorage == nil || tencentString(o.OutputStorage.Type) != "COS" || o.OutputStorage.CosOutputStorage == nil || tencentString(o.Path) == "" || tencentString(o.OutputStorage.CosOutputStorage.Bucket) == "" || tencentString(o.OutputStorage.CosOutputStorage.Region) == "" {
		return nil, errors.New("invalid SmartErase output storage")
	}
	return &SmartEraseResult{Status: "completed", Path: *o.Path, Bucket: tencentString(o.OutputStorage.CosOutputStorage.Bucket), Region: tencentString(o.OutputStorage.CosOutputStorage.Region)}, nil
}

var cosNamePattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// SignCOSObject 为经过校验的腾讯 COS 对象生成临时 GET 地址。
// 它校验凭据、存储桶和地域格式，将绝对地址限制到预期 COS 主机后再签名对象路径。
// 解析和签名失败时保留原始错误供任务记录。
func SignCOSObject(ctx context.Context, bucket, region, key string) (string, error) {
	id, secret := resolveTencentSecret()
	if id == "" || secret == "" || !cosNamePattern.MatchString(bucket) || !cosNamePattern.MatchString(region) {
		return "", errors.New("invalid COS configuration")
	}
	base, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region))
	if err != nil {
		return "", err
	}
	u, err := url.Parse(key)
	if err != nil {
		return "", err
	}
	if u.IsAbs() {
		if u.Host != base.Host || u.Scheme != "https" || u.User != nil {
			return "", errors.New("unexpected COS output host")
		}
		key = u.Path
	}
	key = strings.TrimPrefix(key, "/")
	if key == "" {
		return "", errors.New("empty COS output path")
	}
	c := cos.NewClient(&cos.BaseURL{BucketURL: base}, nil)
	signed, err := c.Object.GetPresignedURL(ctx, http.MethodGet, key, id, secret, time.Hour, nil)
	if err != nil {
		return "", err
	}
	return signed.String(), nil
}
