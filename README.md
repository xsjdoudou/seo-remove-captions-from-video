# removetextfromvideo.io

去硬字幕的海外站。用户上传视频 → 后端调腾讯云 MPS SmartErase → 把成片拉回本地 → 用户预览并下载。

```
浏览器 ──① 上传 ──▶ erase-api ──② 落盘 data/sources/<token>.mp4
                        │
                        ├─③ submit(input_url = https://域名/s/<token>.mp4)
                        │        └──▶ 腾讯云 MPS ──④ 回来 GET /s/<token>.mp4
                        │                              （这一跳必须公网可达）
                        ├─⑤ 轮询 query(task_id)
                        ├─⑥ 成片在 COS，用签名 URL 下载到 data/results/<token>.mp4
                        │     同时删掉源视频
浏览器 ◀─⑦ /r/<token>.mp4 ─┘
```

**整条链路里最容易出事的是第 ④ 步。** 腾讯云 MPS 在它自己的机房里发起这个 GET，
所以 `SOURCE_PUBLIC_BASE` 必须是外网真能访问到的 https 域名——`127.0.0.1` 对它来说
是它自己，内网 IP 它路由不到，挂在 Basic Auth 后面它过不去。配错了的表现是任务提交
成功、几分钟后失败，错误信息是语焉不详的 `Server returned 5XX Server Error reply`。
部署完先跑 `npm run check:tencent`，它会专门验这一条。

## 目录

```
src/              前端（React 19 + Vite 7 + TS），构建期预渲染成静态 HTML
  config.ts       域名、品牌名——换站只改这里
  seo.ts          每个路由的 title/description/JSON-LD，浏览器和构建脚本共用
  lib/history.ts  "最近任务"记录，存在浏览器 localStorage 里
  components/     Workspace.tsx 是工具本体，HistoryList.tsx 是最近任务，
                  ModePicker.tsx 是左边那列的模式选择（自动 / 框选），
                  其余是落地页内容
scripts/
  erase-api.mjs   后端 HTTP 层（独立进程 + vite 中间件两用）
  pipeline.mjs    任务流水线：提交 → 轮询 → 下载成片
  tencent.mjs     腾讯云客户端的 Node 包装（子进程调下面那两个 python）
  tencent_smart_erase.py   TC3 签名 + ProcessMedia/DescribeTaskDetail + COS 签名
  tencent_smart_erase_region.py  框选模式：SubtitleEraseMethod=custom + CustomAreas
  store.mjs       任务状态（内存 Map + 原子写 JSON）
  media.mjs       文件名清洗、格式白名单、ffprobe 取时长
  config.mjs      环境变量 → 校验过的配置对象
  check-tencent.mjs     部署自检
  verify-pipeline.mjs   拿一个公网 URL 跑完整条链路（手工）
  build-canonical-pages.mjs  预渲染 + 生成 sitemap/robots
deploy/           systemd unit + nginx 参考配置
tests/            单元测试（npm test）
data/             上传、成片、jobs.json（已 gitignore）
```

### 为什么腾讯云那部分是 Python

`scripts/tencent_smart_erase.py` 里的 TC3 签名和 COS 签名已经跑通并验证过。
照着移植成 JS 只会多一处可能报 "signature does not match" 的地方，而每个任务
一共只 spawn 十几次 python，开销相对视频处理时间可以忽略。Node 侧只负责
编排和错误分类。

## 本地开发

需要 Node ≥ 20.19、Python 3（装了 `requests`），ffmpeg 可选但建议装
（没有 ffprobe 的话时长限制会失效）。

```bash
cp .env.example .env
chmod 600 .env
vi .env                 # 至少填 TENCENT_SECRET_ID / TENCENT_SECRET_KEY

npm install
npm run dev             # http://127.0.0.1:5173，前端和后端在同一个进程里
```

dev 模式下后端是作为中间件挂在 vite 里的，只需要起一个进程。
本机没有公网入口时 `SOURCE_PUBLIC_BASE` 留空即可：上传、预览、下载、
限流、清理都能正常跑，只有提交到腾讯云那一步会被挡下来并明确告诉你原因。

```bash
npm test                # 单元测试，不花钱、不联网
npm run check:tencent   # 自检：凭证、ffprobe、公网可达性
npm run build           # tsc + vite build + 预渲染 + sitemap
npm run preview         # 用构建产物跑一遍，顺带验证预渲染结果
```

### build 之后

`npm run build` 的产物全在 `dist/` 里，是一个纯静态站点（四个预渲染页面
+ `assets/` + `sitemap.xml` + `robots.txt`）。**它不含后端**——`erase-api`
是另一个进程，生产由 nginx 把 `/api`、`/s`、`/r` 转给它。

本机先验一遍：

```bash
npm run preview         # http://127.0.0.1:10050
```

preview 会同时挂上后端，所以上传流程也能走。重点看这几项：

```bash
# 四个路由的 title/canonical 应该各不相同——相同就说明预渲染没生效
for p in "" how-it-works privacy terms; do
  curl -s http://127.0.0.1:10050/$p | grep -oE '<title>[^<]*'
done
```

然后把 `dist/` 同步到服务器（`rsync -av --delete dist/ 服务器:/srv/removetextfromvideo/dist/`），
nginx 的 root 指向它即可。前端改了要重新 build + 同步；只改了 `scripts/`
下的后端代码则是 `systemctl restart erase-api`，不用重新 build。

想在本机验证"提交 → 轮询 → 下载成片"这一段（会真的产生一次腾讯云计费）：

```bash
node scripts/with-env.mjs node scripts/verify-pipeline.mjs 'https://公网可达的/video.mp4'
```

## 部署

```bash
# 1. 代码和依赖
sudo mkdir -p /srv/removetextfromvideo && cd /srv/removetextfromvideo
git clone <repo> . && npm ci && npm run build

# 2. 配置（放在仓库外面：部署脚本的 git clean 会把仓库里的 .env 删掉）
sudo mkdir -p /etc/removetextfromvideo
sudo cp .env.example /etc/removetextfromvideo/api.env
sudo chmod 600 /etc/removetextfromvideo/api.env
sudo vi /etc/removetextfromvideo/api.env    # 填密钥，SOURCE_PUBLIC_BASE 填真实域名，TRUST_PROXY=true

# 3. 后端
sudo useradd -r -s /usr/sbin/nologin erase
sudo chown -R erase:erase /srv/removetextfromvideo/data
sudo cp deploy/erase-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now erase-api

# 4. nginx + TLS
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/removetextfromvideo
sudo ln -s /etc/nginx/sites-available/removetextfromvideo /etc/nginx/sites-enabled/
sudo certbot --nginx -d removetextfromvideo.io -d www.removetextfromvideo.io
sudo nginx -t && sudo systemctl reload nginx

# 5. 验证
npm run check:tencent
```

部署后记得在 Google Search Console 提交 `https://removetextfromvideo.io/sitemap.xml`。

### 几个容易踩的点

- **nginx 的 `client_max_body_size` 要 ≥ `MAX_UPLOAD_BYTES`**，否则用户传到一半
  收到的是 nginx 自己那个没有样式的 413 页面。
- **`proxy_request_buffering off`**，否则 nginx 会先把整个请求体落盘再转发，
  用户的进度条会在 100% 处莫名其妙地卡住。
- **`TRUST_PROXY=true` 只在 nginx 后面开**。裸跑时开着，任何人伪造一个
  `X-Forwarded-For` 就能绕过限流。
- **`API_HOST` 默认只监听 127.0.0.1**，别图省事改成 `0.0.0.0` 然后把端口开到公网——
  后端自己没有 TLS。

## 行为边界（实测）

两种模式走的是两套参数：

| | 自动 | 框选 |
| --- | --- | --- |
| 脚本 | `tencent_smart_erase.py` | `tencent_smart_erase_region.py` |
| MPS 参数 | `Definition=101`（去字幕模板） | `Definition=0` + `RawParameter`，`SubtitleEraseMethod=custom` |
| 擦哪儿 | 模型自己找 | 只擦传过去的那几个矩形 |
| 接口 | `POST /api/jobs` | `POST /api/jobs?area=l,t,r,b`（可重复，最多 6 个） |

坐标一律是 0~1 的比例（左上角为原点），对应腾讯的 `Unit=1`（percent）。
右下角在前端就收到 0.999：腾讯要求 percent 坐标落在 **[0,1) 的开区间**里，
而字幕恰恰最常贴着底边。

自动模式用的 `TENCENT_DEFINITION=101` 是一个**去字幕**模板。实测结论：

- ✅ 画面中下部的硬字幕能干净去掉，背景（人物衣服、场景）重建得很自然
- ❌ 顶部横幅、角标 Logo、角落水印**不会**被去掉——腾讯的去字幕模型默认只检测
  画面中下部的字幕区域

落地页文案是照着**自动模式**的实际行为写的，没有承诺去水印。画面中下部以外的
东西要靠框选模式：它不做检测，框到哪擦到哪，所以顶部横幅这类自动模式碰不到的
位置也能处理（效果仍取决于背景复杂度）。

真要专门做去水印的话，还是建议用 `CreateSmartEraseTemplate` 建一个
`EraseType=watermark` 的模板，拿到新的 Definition，按模式挑 Definition。

## 隐私与清理

- 成片下载到本地后立刻删源视频——它还挂在一个公网能取的 URL 上，早删早安全。
- 源视频和成片都在 `RETENTION_MS`（默认 24 小时）之后被清理任务删掉。
- `/s/` 和 `/r/` 的 URL 里是 96 位随机 token，URL 本身就是访问凭证；
  robots.txt 里禁止抓取，响应头是 `no-store`。
- 任务 id 和文件 token 是两个独立的随机值：拿到公开的源文件 URL 不等于
  能读到任务状态（里面有 IP 和错误详情）。

## 工具区的几个设计决定

布局是「16:9 画布 + 右侧栏」，参考了 subtitleremover.com/studio 的骨架，
但有三处刻意做得不一样：

- **画布是横的，不是竖的。** 形状跟着视频走。竖框只在"空着等人拖文件"那一刻
  说得通，之后每一帧都在浪费宽度。固定 16:9 还顺带让上传→处理→结果三个状态
  切换时版面纹丝不动。
- **等待时画布里放的是用户自己的片子**（本地 object URL，不耗流量），
  不是一个转圈的图标。上传时就能确认自己选对了文件。
- **出结果后可以左右对照原片。** "到底去干净没有"是用户唯一真正关心的问题，
  只看成片答不了。两个 `<video>` 叠着切透明度而不是换 `src`——换 src 会重新
  加载、闪一下黑屏，正好毁掉对照本身。切完是暂停的，比对静帧才看得清。
  原片来自本地文件，所以这个功能不花任何带宽；从历史记录回来的任务没有本地
  文件，对照开关会自动隐藏。

侧栏空状态放的是格式、耗时、隐私这些首次来访者真正需要的信息，而不是一句
"暂无记录"——那是一整块死掉的版面。有记录之后它自然让位。

## "最近任务"为什么存在浏览器里
站点没有登录体系，服务端认不出"你"是谁。真要做成服务端的历史记录，就得先发
一个长期 cookie 把匿名访客串起来——为了一个便利功能建一套追踪，不划算，也和
隐私页的承诺冲突。所以记录放在 `localStorage`，服务端不存、也看不到。

代价是换设备、换浏览器就看不到了。对一个 24 小时后文件就被删掉的工具来说，
这个取舍是划算的。真正的数据仍然在服务端，`localStorage` 里只有任务 id 和一份
用于即时渲染的快照，状态以 `/api/jobs/:id` 的返回为准。

附带的好处是**关掉标签页不丢任务**：几分钟的处理时间里很多人会去干别的，
回来之后列表里那条还在，没跑完的会继续轮询到完成。

改了 `RETENTION_MS` 记得同步改 `src/components/LegalPage.tsx` 里写的 24 小时，
以及 `HistoryList.tsx` 底部那行提示。
