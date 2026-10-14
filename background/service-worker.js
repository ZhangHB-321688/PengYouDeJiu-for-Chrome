/**
 * PengYouDeJiu - 后台 Service Worker (MV3)
 * 负责初始化默认配置，并通过 offscreen 文档循环播放背景音乐。
 */

const DEFAULT_SETTINGS = {
  enabled: true,
};

const OFFSCREEN_URL = "offscreen/offscreen.html";

/** offscreen 文档创建中的 promise，避免并发重复创建 */
let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await chrome.storage.sync.set(current);
    console.log("[PengYouDeJiu] 扩展已安装，默认配置已写入。");
  }
});

/** offscreen 文档是否已存在 */
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

/** 确保 offscreen 文档已创建 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "循环播放背景音乐",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

/** 开始（或继续）循环播放 */
async function startAudio() {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_AUDIO" });
  return { playing: true };
}

/** 暂停播放，保留播放进度 */
async function pauseAudio() {
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "PAUSE_AUDIO" });
  }
  return { playing: false, paused: true };
}

/** 停止播放并复位，关闭 offscreen 文档释放资源 */
async function stopAudio() {
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_AUDIO" });
    await chrome.offscreen.closeDocument();
  }
  return { playing: false, paused: false };
}

/** 读取当前播放状态（以 offscreen 文档为准，避免 Service Worker 休眠后状态丢失） */
async function queryAudio() {
  if (!(await hasOffscreenDocument())) {
    return { playing: false, paused: false, position: 0, duration: 0 };
  }
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "QUERY_AUDIO",
  });
  const playing = Boolean(res?.playing);
  return {
    playing,
    // 文档存在但未在播放 => 处于暂停
    paused: !playing,
    position: Number(res?.position) || 0,
    duration: Number(res?.duration) || 0,
  };
}

/** 把音乐状态广播给所有页面的内容脚本，用于驱动缩放的时间参数 */
async function broadcastMusicState(state) {
  const info = state || (await queryAudio());
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    chrome.tabs
      .sendMessage(tab.id, { type: "MUSIC_STATE", ...info })
      .catch(() => {});
  }
}

/** 执行音乐操作并广播最新状态 */
async function applyAudioAction(action) {
  if (action === "pause") await pauseAudio();
  else if (action === "stop") await stopAudio();
  else await startAudio();

  const info = await queryAudio();
  await broadcastMusicState(info);
  return info;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return false;

  if (msg?.type === "SET_AUDIO") {
    // 兼容 { action } 与旧的 { playing } 两种写法
    const action = msg.action || (msg.playing ? "play" : "stop");
    applyAudioAction(action)
      .then(sendResponse)
      .catch(() =>
        sendResponse({ playing: false, paused: false, position: 0, duration: 0 })
      );
    return true; // 异步返回
  }

  if (msg?.type === "GET_AUDIO") {
    queryAudio()
      .then(sendResponse)
      .catch(() =>
        sendResponse({ playing: false, paused: false, position: 0, duration: 0 })
      );
    return true; // 异步返回
  }

  return false;
});
