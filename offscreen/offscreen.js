/**
 * PengYouDeJiu - offscreen 文档
 * 在扩展上下文中循环播放背景音乐（不受页面自动播放策略限制，
 * 也不会因切换标签页或关闭弹窗而中断）。
 * 同时向外提供播放进度，供内容脚本驱动缩放效果。
 */

const AUDIO_URL = chrome.runtime.getURL("audio/audio.mp3");

/** @type {HTMLAudioElement | null} */
let audio = null;
/** 时长等元数据就绪的 promise */
let metaReady = Promise.resolve();

function getAudio() {
  if (!audio) {
    audio = new Audio(AUDIO_URL);
    audio.loop = true;
    metaReady = new Promise((resolve) => {
      if (Number.isFinite(audio.duration)) {
        resolve();
        return;
      }
      audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
      audio.addEventListener("error", () => resolve(), { once: true });
    });
  }
  return audio;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "PLAY_AUDIO") {
    getAudio()
      .play()
      .catch((err) => console.warn("[PengYouDeJiu] 播放失败：", err));
    // 等元数据就绪再回应，保证调用方能拿到时长
    metaReady.then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "PAUSE_AUDIO") {
    const el = getAudio();
    el.pause(); // 保留 currentTime，便于继续播放
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "STOP_AUDIO") {
    const el = getAudio();
    el.pause();
    el.currentTime = 0;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "QUERY_AUDIO") {
    if (!audio) {
      sendResponse({ playing: false, position: 0, duration: 0 });
      return false;
    }
    const el = audio;
    metaReady.then(() =>
      sendResponse({
        playing: !el.paused,
        position: el.currentTime || 0,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      })
    );
    return true;
  }

  return false;
});
