const els = {
  enabled: document.getElementById("enabled"),
  status: document.getElementById("status"),
  scaleAmount: document.getElementById("scaleAmount"),
  toggleScale: document.getElementById("toggleScale"),
  toggleAudio: document.getElementById("toggleAudio"),
  pauseAudio: document.getElementById("pauseAudio"),
};

/** 获取当前标签页 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 向内容脚本发送消息；内容脚本未注入时返回 null */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    return null;
  }
}

function renderStatus(text) {
  els.status.textContent = text;
}

/** 渲染音乐按钮文案与状态 */
function renderAudio(status) {
  const playing = Boolean(status?.playing);
  const paused = Boolean(status?.paused);

  els.toggleAudio.textContent = playing || paused ? "停止音乐" : "播放音乐";
  els.toggleAudio.classList.toggle("is-active", playing || paused);

  els.pauseAudio.textContent = paused ? "继续播放" : "暂停音乐";
  els.pauseAudio.classList.toggle("is-active", paused);
  els.pauseAudio.disabled = !playing && !paused;
}

/** 向后台发送音乐操作（play / pause / stop）并刷新按钮状态 */
async function setAudio(action) {
  const res = await chrome.runtime
    .sendMessage({ type: "SET_AUDIO", action })
    .catch(() => null);
  renderAudio(res);
}

function setActionsEnabled(enabled) {
  els.toggleScale.disabled = !enabled;
}

function renderState(state) {
  if (!state) {
    renderStatus("请刷新页面后再试");
    setActionsEnabled(false);
    return;
  }
  els.enabled.checked = Boolean(state.enabled);

  const scaling = Boolean(state.scaling);
  els.toggleScale.textContent = scaling ? "停止尺寸变换" : "开始尺寸变换";
  els.toggleScale.classList.toggle("is-active", scaling);

  renderStatus(state.enabled ? "插件已启用" : "插件已停用");
  setActionsEnabled(state.enabled);
}

/** 主流程：读取开关与页面状态 */
async function init() {
  const { enabled = true, scaleAmount = 0.1 } = await chrome.storage.sync.get([
    "enabled",
    "scaleAmount",
  ]);
  els.enabled.checked = enabled;
  els.scaleAmount.value = String(scaleAmount);

  // 音乐状态由后台管理，与页面内容脚本无关，单独读取
  const audio = await chrome.runtime
    .sendMessage({ type: "GET_AUDIO" })
    .catch(() => null);
  renderAudio(audio);

  const tab = await getActiveTab();
  if (!tab?.id) {
    renderStatus("未找到可操作的标签页");
    setActionsEnabled(false);
    return;
  }

  const state = await sendToContent(tab.id, { type: "GET_STATE" });
  renderState(state ?? { enabled, count: 0 });
}

/** 开关切换 */
els.enabled.addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.sync.set({ enabled });

  const tab = await getActiveTab();
  if (!tab?.id) return;
  const state = await sendToContent(tab.id, { type: "SET_ENABLED", enabled });
  renderState(state ?? { enabled, count: 0 });
});

/** 缩放强度：只要填的是数字就保存，不做范围限制 */
els.scaleAmount.addEventListener("input", () => {
  const raw = els.scaleAmount.value.trim();
  if (raw === "") return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  chrome.storage.sync.set({ scaleAmount: value });
});

/** 尺寸变换开关 */
els.toggleScale.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const next = !els.toggleScale.classList.contains("is-active");
  const state = await sendToContent(tab.id, {
    type: next ? "START_SCALE" : "STOP_SCALE",
  });
  if (state) renderState(state);
});

/** 音乐播放开关（循环播放，跨标签页持续） */
els.toggleAudio.addEventListener("click", () => {
  const active = els.toggleAudio.classList.contains("is-active");
  setAudio(active ? "stop" : "play");
});

/** 暂停 / 继续：暂停时缩放也停在当前变换状态 */
els.pauseAudio.addEventListener("click", () => {
  const paused = els.pauseAudio.classList.contains("is-active");
  setAudio(paused ? "play" : "pause");
});

init();
