# Proposals

## [done] 添加 favicon 和 PWA manifest
## [done] WebSocket 心跳超时断开
## [done] 添加 project 排序/搜索
## [done] 终端字体大小设置
## [done] 退出进程 Session 内存泄漏清理
## [done] store.js 原子写入防数据损坏
## [done] WebSocket 连接中间状态（验收官建议）
## [done] 空 sidebar 添加空状态引导（验收官建议）
## [done] Claude 模式图标改为更直觉的符号（验收官建议）
## [done] Landing 表单 CSS 变量未定义（验收官建议）
## [done] 二级文字对比度不达标（验收官建议）

## [done] history.jsonl 大文件读取优化
- 背景：routes.js 的 listClaudeSessions 用 readFileSync 读取整个 history.jsonl，大文件可能占用大量内存
- 建议：改用流式读取（readline + createReadStream），或只读取文件末尾部分
- 收益：减少内存峰值，支持大型 history 文件
- 风险：低

---

## [已完成] 猫娘秘书语音合成（TTS）集成方案（验收官调研，2026-03-20）

### 背景

主人希望 nanocode 终端里的 Claude 猫娘秘书能"开口说话"——将文字回复转为语音播放。

### 方案对比

| 特性 | GPT-SoVITS v3 | Fish Speech S2 |
|------|--------------|----------------|
| GitHub | [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) |
| Star | 40k+ | 20k+ |
| 声音克隆 | 1 分钟音频即可克隆 | 10 秒音频即可克隆 |
| 多语言 | 中/英/日/粤/韩 | 80+ 语言 |
| API 端口 | 默认 9880 | 默认 8080 |
| 流式输出 | ✅ `streaming_mode=true` | ✅ 支持 |
| VRAM | ~4GB (推理) | ~24GB (S2 Pro) / ~6GB (S2 Mini) |
| 延迟 | 较低（v3 优化后 <1s） | 中等 |
| Docker | ✅ `opea/gpt-sovits` | ✅ `docker-fish-speech-server` |
| **推荐** | **✅ 首选**（VRAM 低、生态好、猫娘音色多） | 备选（VRAM 要求高） |

### GPT-SoVITS v3 部署方式

#### 安装
```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS
pip install -r requirements.txt
# 下载预训练模型到 GPT_SoVITS/pretrained_models/
```

#### Docker 部署（推荐）
```bash
docker run -d --gpus all \
  -p 9880:9880 -p 9871:9871 -p 9872:9872 \
  --shm-size=16g \
  -v /path/to/models:/app/GPT_SoVITS/pretrained_models \
  opea/gpt-sovits
```

#### 启动 API Server
```bash
python api_v2.py -a 0.0.0.0 -p 9880
```

### API 调用方式

#### 1. 基础 TTS（POST JSON）
```bash
curl http://127.0.0.1:9880/ -XPOST \
  -d '{
    "text": "主人～有什么吩咐喵？",
    "text_language": "zh"
  }' --output out.wav
```

#### 2. 指定参考音色（声音克隆）
```bash
# 先设置参考音频
curl http://127.0.0.1:9880/change_refer \
  -d '{
    "refer_wav_path": "/models/catgirl_voice.wav",
    "prompt_text": "这是猫娘秘书的声音喵",
    "prompt_language": "zh"
  }'

# 然后合成
curl http://127.0.0.1:9880/ -XPOST \
  -d '{"text": "主人早安喵～", "text_language": "zh"}' \
  --output morning.wav
```

#### 3. 流式输出（低延迟）
```
GET http://127.0.0.1:9880/tts?text=你好喵&text_lang=zh&ref_audio_path=catgirl.wav&prompt_lang=zh&streaming_mode=true&media_type=ogg
```
返回 `Transfer-Encoding: chunked` 的音频流。

#### 4. V3 专用 API（[CNFlyCat/GPT-SoVITS-V3-Infer-API](https://github.com/CNFlyCat/GPT-SoVITS-V3-Infer-API)）
```python
import requests
resp = requests.post("http://127.0.0.1:9880/tts", json={
    "text": "喵～",
    "text_lang": "zh",
    "ref_audio_path": "catgirl.wav",
    "prompt_text": "这是参考音频的文字",
    "prompt_lang": "zh",
    "media_type": "wav",
    "streaming_mode": True,
    "batch_size": 1,
    "top_k": 15,
    "temperature": 0.8,
}, stream=True)
with open("output.wav", "wb") as f:
    for chunk in resp.iter_content(chunk_size=4096):
        f.write(chunk)
```

### 猫娘 / 二次元音色资源

| 资源 | 说明 | 链接 |
|------|------|------|
| SoVITS Anime Female | GPT-SoVITS 专用动漫女声模型 | [cpumaxx/SoVITS-anime-female-brickwall-tts](https://huggingface.co/cpumaxx/SoVITS-anime-female-brickwall-tts) |
| Multilingual Anime TTS | VITS + Umamusume 角色音色 | [Plachta/VITS-Umamusume](https://huggingface.co/spaces/Plachta/VITS-Umamusume-voice-synthesizer) |
| Moe TTS | 多角色萌系语音合成 | [skytnt/moe-tts](https://huggingface.co/spaces/skytnt/moe-tts) |
| RVC Anime Models | Haruka 等典型动漫女声 RVC 模型 | [AIHeaven/rvc-models](https://huggingface.co/AIHeaven/rvc-models) |
| Kokoro TTS | 高质量 TTS，支持多风格 | [hexgrad/Kokoro-TTS](https://huggingface.co/spaces/hexgrad/Kokoro-TTS) |

**推荐方案**：用 GPT-SoVITS + SoVITS-anime-female 模型作为基础音色，或录制 1 分钟猫娘语音样本做 few-shot 克隆。

### 前端 Web Audio API 播放方案

#### 方案 A：简单 `<audio>` 标签（非流式）
```javascript
// 收到完整 WAV 后播放
const blob = new Blob([audioData], { type: 'audio/wav' });
const url = URL.createObjectURL(blob);
const audio = new Audio(url);
audio.play();
```

#### 方案 B：AudioWorklet 流式播放（低延迟，推荐）
```javascript
// 1. 创建 AudioContext
const ctx = new AudioContext({ latencyHint: 'interactive' });

// 2. WebSocket 接收 PCM chunks
const ws = new WebSocket('ws://localhost:3001/tts-stream');
ws.binaryType = 'arraybuffer';

// 3. 用 AudioWorklet 实时解码播放
await ctx.audioWorklet.addModule('/js/pcm-player-worklet.js');
const node = new AudioWorkletNode(ctx, 'pcm-player');
node.connect(ctx.destination);

ws.onmessage = (e) => {
    node.port.postMessage(new Float32Array(e.data));
};
```

#### 方案 C：MediaSource Extensions（中间方案）
```javascript
const mediaSource = new MediaSource();
const audio = new Audio();
audio.src = URL.createObjectURL(mediaSource);
mediaSource.addEventListener('sourceopen', () => {
    const sb = mediaSource.addSourceBuffer('audio/webm; codecs=opus');
    // 逐 chunk append
    fetch('/api/tts?text=喵&streaming=true').then(r => {
        const reader = r.body.getReader();
        // 流式读取并 appendBuffer
    });
});
```

**参考库**：[3LAS (Low Latency Live Audio Streaming)](https://github.com/JoJoBond/3LAS) — TypeScript 实现的低延迟浏览器音频流播放。

### nanocode 集成架构

```
┌─────────────┐     WebSocket      ┌──────────────┐    HTTP/Stream    ┌──────────────┐
│  浏览器      │  ←─ audio chunks ─  │  nanocode     │  ──────────────→  │ GPT-SoVITS   │
│  (Web Audio) │                    │  server.js    │    POST /tts     │  :9880       │
│              │  ── text msg ────→  │  /tts-stream  │                  │              │
└─────────────┘                    └──────────────┘                  └──────────────┘
```

1. Claude 回复文字 → nanocode server 截取需要语音化的文字
2. server.js 调 GPT-SoVITS `/tts` API（streaming_mode=true）
3. 音频 chunks 通过 WebSocket 转发到浏览器
4. 浏览器用 AudioWorklet 或 `<audio>` 播放

### 实施优先级

1. **P0**：部署 GPT-SoVITS Docker（`opea/gpt-sovits`），确认 API 可调用
2. **P1**：找/制作猫娘音色参考音频，配置 `change_refer`
3. **P2**：nanocode server.js 增加 `/api/tts` 代理端点
4. **P3**：前端增加 TTS 播放按钮（先用方案 A 非流式）
5. **P4**：升级为 WebSocket 流式播放（方案 B）

### 风险
- GPT-SoVITS 需要 GPU（~4GB VRAM），与 P3-SAM 共享 GPU 可能冲突
- 音色质量依赖参考音频质量（需要干净、无噪音的 3-10 秒样本）
- 流式播放在移动端 Safari 可能有兼容性问题（需要用户手势触发 AudioContext）

---

## [待评估] TTS 音色优化 — 更少女更甜更二次元（验收官调研，2026-03-21）

### 目标音色

参考《巧克力与香子兰》（NEKOPARA / ネコぱら）猫娘角色：甜美、少女、二次元感强。

### 方案 1：换参考音频（最快，无需训练）

GPT-SoVITS 支持 zero-shot（5 秒音频即可克隆 80-95% 相似度）。只需：
1. 找一段 NEKOPARA 角色语音（3-10 秒，干净无 BGM）
2. 更新 `/api/tts/voice` 的 `ref_audio_path` 和 `prompt_text`

**推荐参考音频来源**：
- 从 NEKOPARA 游戏提取角色语音（バニラ/Vanilla 或 ショコラ/Chocola 的台词音频）
- 或用 edge-tts `ja-JP-NanamiNeural`（日语女声，甜美风格）生成参考音频：
  ```bash
  pip install edge-tts
  edge-tts --voice ja-JP-NanamiNeural --text "こんにちは、ご主人様！猫耳メイドのバニラです、にゃ～" --write-media /tmp/ref_nanami.mp3
  ```
- 中文甜美女声可用 `zh-CN-XiaoxiaoNeural`（晓晓）的 cheerful/affectionate 风格

### 方案 2：下载社区预训练模型（质量更高）

| 模型 | 说明 | 链接 |
|------|------|------|
| xiaoheiqaq/GPT-Sovits-models | 含 Kokomi 等角色音色，1h 训练数据 | [HuggingFace](https://huggingface.co/xiaoheiqaq/GPT-Sovits-models) |
| UmaDiffusion/uma-voice-gpt-sovits-v2 | 赛马娘角色音色 | [HuggingFace](https://huggingface.co/UmaDiffusion/uma-voice-gpt-sovits-v2) |
| Some Anime Girl | GPT-SoVITS 动漫女声，日语最佳 | [voice-models.com](https://voice-models.com/model/1s6BOsQOi7D) |
| cpumaxx/SoVITS-anime-female | 动漫女声通用模型 | [HuggingFace](https://huggingface.co/cpumaxx/SoVITS-anime-female-brickwall-tts) |

使用方式：下载 `.pth` 权重文件，放到 GPT-SoVITS 的 `pretrained_models/` 目录，在 API 中指定 model path。

### 方案 3：自制 fine-tune（质量最高，需 1 分钟音频）

1. 准备 1 分钟 NEKOPARA 角色干净语音（无 BGM、无杂音）
2. GPT-SoVITS WebUI 一键训练（"One-Click Triple Action"：ASR → 分割 → 训练）
3. 约 10-20 分钟训练完成
4. 导出 `.pth` 权重用于 API 推理

### 推荐执行步骤

1. **P0（立即）**：用 edge-tts `ja-JP-NanamiNeural` 生成一段甜美日语参考音频，通过 `/api/tts/voice` 更新
2. **P1（短期）**：下载 `xiaoheiqaq/GPT-Sovits-models` 或 `UmaDiffusion/uma-voice` 的角色模型，替换 pretrained weights
3. **P2（如需极致）**：提取 NEKOPARA 游戏语音做 1 分钟 fine-tune

### edge-tts 可用的甜美女声

| Voice ID | 语言 | 风格 |
|----------|------|------|
| `ja-JP-NanamiNeural` | 日语 | 甜美少女 |
| `zh-CN-XiaoxiaoNeural` | 中文 | 多风格（cheerful/affectionate 最甜） |
| `zh-CN-XiaoyiNeural` | 中文 | 少女感 |
| `ko-KR-SunHiNeural` | 韩语 | 甜美 |

### 参考
- [GPT-SoVITS Few-Shot Guide](https://www.nite07.com/en/posts/gpt-sovits/)
- [xiaoheiqaq GPT-SoVITS Models](https://huggingface.co/xiaoheiqaq/GPT-Sovits-models)
- [edge-tts Voice List](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8690a20462)
- [UmaDiffusion Voice Models](https://huggingface.co/UmaDiffusion/uma-voice-gpt-sovits-v2)

## [待评估] Settings 中添加 text_lang 选择器
- 背景：text_lang 目前在代码里 hardcode 为 'en'，换参考音频后如果用户想合成中/日文无法在 UI 切换
- 建议：/api/tts/voice 添加 text_lang 参数，Settings 中添加下拉选择（en/zh/ja/auto）
- 收益：用户可根据参考音频语言动态切换，无需改代码
- 风险：低
