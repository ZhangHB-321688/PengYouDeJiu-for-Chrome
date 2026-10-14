/**
 * PengYouDeJiu - 内容脚本
 * 负责在页面中执行元素修改，并记录原始状态以便恢复。
 */
(() => {
  if (window.__PYJ_LOADED__) return;
  window.__PYJ_LOADED__ = true;

  /**
   * 缩放系数计算函数由 scale.js 提供（占位实现）。
   * 定义位置：content/scale.js  ->  window.__PYJ_computeScale(now)
   * 入参 now 为毫秒时间戳，返回 { width, height } 两组系数。
   */
  const computeScale = window.__PYJ_computeScale;

  /** 高亮时匹配的元素选择器（可按需扩展） */
  const HIGHLIGHT_SELECTOR = "h1, h2, h3, a";

  /** 需要隐藏的干扰元素选择器（可按需扩展） */
  const HIDE_SELECTORS = [
    "[class*='ad-']",
    "[id*='ad-']",
    "[class*='advert']",
    "aside",
  ];

  const state = {
    enabled: true,
    /** 已修改元素 -> 原始快照 */
    modified: new Map(),
  };

  /** 缩放强度（由 popup 配置，默认 0.1，任意数字均可） */
  let scaleAmount = 0.1;

  /** 时间缩放效果的状态 */
  const scaleEffect = {
    running: false,
    rafId: null,
    /** 点击"开始尺寸变换"的时刻，作为时间原点 */
    startTime: 0,
    /** 页面中最深的层数 */
    maxDepth: 0,
  };

  /**
   * 音乐播放进度基准（由后台同步过来）。
   * active 为 true 时，缩放效果改用音乐播放进度作为时间参数；
   * paused 为 true 时，播放进度冻结在暂停瞬间，缩放也随之停在当前变换状态。
   * 播放进度由这里按本地时间推进（音乐在 offscreen 里播放，本脚本按同一时长取模估算）。
   */
  const musicClock = {
    active: false,
    paused: false,
    /** 曲目时长（秒） */
    duration: 0,
    /** 同步时的播放位置（秒） */
    basePosition: 0,
    /** 收到同步信息时的本地时间戳（performance.now） */
    startedAt: 0,
    /** 暂停时的冻结进度（毫秒） */
    frozenMs: 0,
  };

  /** 用后台返回的信息更新音乐播放基准 */
  function setMusicState(info) {
    const playing = Boolean(info?.playing);
    const paused = Boolean(info?.paused);
    const duration = Number(info?.duration) || 0;
    const position = Number(info?.position) || 0;

    if (duration <= 0 || (!playing && !paused)) {
      // 未播放 / 已停止 / 时长未知：回退到按点击时间计时
      musicClock.active = false;
      musicClock.paused = false;
      return;
    }

    musicClock.duration = duration;
    musicClock.active = true;

    if (playing) {
      musicClock.paused = false;
      musicClock.basePosition = position;
      musicClock.startedAt = performance.now();
    } else {
      // 暂停：把进度冻结在暂停瞬间
      musicClock.paused = true;
      musicClock.frozenMs = (position % duration) * 1000;
    }
  }

  /** 当前音乐的播放进度（毫秒）；音乐未在播放时返回 null，暂停时返回冻结值 */
  function currentMusicMs() {
    if (!musicClock.active) return null;
    if (musicClock.paused) return musicClock.frozenMs;
    const sec =
      musicClock.basePosition +
      (performance.now() - musicClock.startedAt) / 1000;
    return (sec % musicClock.duration) * 1000;
  }

  chrome.storage?.sync.get("enabled", ({ enabled = true }) => {
    state.enabled = enabled;
    // 进入页面后自动开始尺寸变换，之后仅能手动停止
    if (state.enabled) startScaleEffect();
  });

  /** 读取缩放强度，保存的必须是数字（不做范围限制） */
  function setScaleAmount(value) {
    const n = Number(value);
    if (Number.isFinite(n)) scaleAmount = n;
  }

  chrome.storage?.sync.get({ scaleAmount: 0.1 }, ({ scaleAmount: value }) => {
    setScaleAmount(value);
  });

  // popup 改动缩放强度后即时生效，无需刷新页面
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.scaleAmount) return;
    setScaleAmount(changes.scaleAmount.newValue);
  });

  /** 记录元素原始状态（仅首次） */
  function snapshot(el) {
    if (state.modified.has(el)) return;
    state.modified.set(el, {
      className: el.className,
      style: el.getAttribute("style"),
      hidden: el.hidden,
    });
  }

  function markModified(el) {
    snapshot(el);
  }

  function highlight() {
    document.querySelectorAll(HIGHLIGHT_SELECTOR).forEach((el) => {
      markModified(el);
      el.classList.add("pyj-highlight");
    });
    return state.modified.size;
  }

  function hide() {
    const selector = HIDE_SELECTORS.join(",");
    document.querySelectorAll(selector).forEach((el) => {
      markModified(el);
      el.classList.add("pyj-hidden");
    });
    return state.modified.size;
  }

  function reset() {
    stopScaleEffect();
    state.modified.forEach((snap, el) => {
      el.className = snap.className;
      if (snap.style === null) el.removeAttribute("style");
      else el.setAttribute("style", snap.style);
      el.hidden = snap.hidden;
    });
    state.modified.clear();
    return 0;
  }

  /* ---------------- 时间缩放效果 ---------------- */

  const DEPTH_ATTR = "data-pyj-depth";
  const STYLE_ID = "pyj-scale-style";

  /**
   * 给每个元素标注层数（自下而上）：
   * 没有子元素的记 0；父节点 = max(自己 + 1, 父节点原有层数)。
   * 返回最大层数。
   */
  function assignDepth() {
    const elements = Array.from(document.querySelectorAll("body, body *"));
    const depthMap = new Map();
    for (const el of elements) depthMap.set(el, 0);

    // 反向遍历：子节点先于父节点，子节点的层数确定后再更新父节点
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const el = elements[i];
      const parent = el.parentElement;
      if (!parent || !depthMap.has(parent)) continue;
      const candidate = depthMap.get(el) + 1;
      if (candidate > depthMap.get(parent)) depthMap.set(parent, candidate);
    }

    let maxDepth = 0;
    for (const [el, depth] of depthMap) {
      el.setAttribute(DEPTH_ATTR, String(depth));
      if (depth > maxDepth) maxDepth = depth;
    }
    return maxDepth;
  }

  /**
   * 给变换开始后新插入的子树补标层数（增量处理，不整页重扫）：
   * 子树内部自下而上算，再沿祖先链向上传播 max(自己+1, 原值)。
   * 返回过程中出现的最大层数。
   */
  function markSubtree(root) {
    let max = 0;
    const els = [root, ...root.querySelectorAll("*")];
    // 反向遍历：后代先于祖先，保证读到的子节点层数已确定
    for (let i = els.length - 1; i >= 0; i -= 1) {
      const el = els[i];
      let d = 0;
      for (const child of el.children) {
        const cd = Number(child.getAttribute(DEPTH_ATTR)) || 0;
        if (cd + 1 > d) d = cd + 1;
      }
      el.setAttribute(DEPTH_ATTR, String(d));
      if (d > max) max = d;
    }

    // 沿祖先链向上传播
    let node = root.parentElement;
    let childDepth = Number(root.getAttribute(DEPTH_ATTR)) || 0;
    while (node) {
      const need = childDepth + 1;
      const cur = Number(node.getAttribute(DEPTH_ATTR)) || 0;
      if (need <= cur) break;
      node.setAttribute(DEPTH_ATTR, String(need));
      if (need > max) max = need;
      childDepth = need;
      node = node.parentElement;
    }
    return max;
  }

  /** 变换期间的 DOM 变更监听器 */
  let depthObserver = null;

  /** 开始监听新插入的元素 */
  function observeMutations() {
    if (depthObserver) return;
    depthObserver = new MutationObserver((records) => {
      let max = scaleEffect.maxDepth;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const m = markSubtree(node);
          if (m > max) max = m;
        }
      }
      // 新元素让最大层数变大时，补上对应层数的 CSS 规则与变量
      if (max > scaleEffect.maxDepth) {
        scaleEffect.maxDepth = max;
        ensureStyle(max);
      }
    });
    depthObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /** 停止监听 */
  function disconnectObserver() {
    if (depthObserver) {
      depthObserver.disconnect();
      depthObserver = null;
    }
  }

  /** 为每个层数生成一条缩放规则，各自读取对应层数的 CSS 变量 */
  function ensureStyle(maxDepth) {
    let css = "";
    for (let d = 0; d <= maxDepth; d += 1) {
      css +=
        `html.pyj-scaling [${DEPTH_ATTR}="${d}"]{` +
        `transform:scale(var(--pyj-sx-${d}),var(--pyj-sy-${d})) !important;` +
        `transform-origin:top left !important;}`;
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }
    style.textContent = css;
  }

  /**
   * 应用缩放：把每层数算出的系数写进对应的 CSS 变量。
   * 每帧只更新 2 × 层数 个变量，浏览器统一重算，无需逐元素写内联样式。
   */
  function applyScale(elapsed) {
    const rootStyle = document.documentElement.style;
    for (let d = 0; d <= scaleEffect.maxDepth; d += 1) {
      const scale = computeScale(elapsed, d, scaleAmount);
      rootStyle.setProperty(`--pyj-sx-${d}`, String(scale.width));
      rootStyle.setProperty(`--pyj-sy-${d}`, String(scale.height));
    }
  }

  /**
   * 每一帧：音乐在播放时用「音乐的播放进度」，否则用「当前时间 - 点击开始的时间」
   */
  function tick() {
    if (!scaleEffect.running) return;
    const musicMs = currentMusicMs();
    const time = musicMs === null ? Date.now() - scaleEffect.startTime : musicMs;
    applyScale(time);
    scaleEffect.rafId = requestAnimationFrame(tick);
  }

  function startScaleEffect() {
    if (scaleEffect.running) return;
    scaleEffect.running = true;
    scaleEffect.startTime = Date.now();
    scaleEffect.maxDepth = assignDepth();
    ensureStyle(scaleEffect.maxDepth);
    document.documentElement.classList.add("pyj-scaling");
    observeMutations();
    // 先拉取一次音乐状态，正在播放则用播放进度驱动
    chrome.runtime
      .sendMessage({ type: "GET_AUDIO" })
      .then(setMusicState)
      .catch(() => {});
    tick();
  }

  function stopScaleEffect() {
    scaleEffect.running = false;
    disconnectObserver();
    if (scaleEffect.rafId) cancelAnimationFrame(scaleEffect.rafId);
    scaleEffect.rafId = null;
    document.documentElement.classList.remove("pyj-scaling");
    document.getElementById(STYLE_ID)?.remove();

    const rootStyle = document.documentElement.style;
    for (let d = 0; d <= scaleEffect.maxDepth; d += 1) {
      rootStyle.removeProperty(`--pyj-sx-${d}`);
      rootStyle.removeProperty(`--pyj-sy-${d}`);
    }
    scaleEffect.maxDepth = 0;
    document
      .querySelectorAll(`[${DEPTH_ATTR}]`)
      .forEach((el) => el.removeAttribute(DEPTH_ATTR));
  }

  function currentState() {
    return {
      enabled: state.enabled,
      count: state.modified.size,
      scaling: scaleEffect.running,
    };
  }

  const handlers = {
    GET_STATE: () => currentState(),
    SET_ENABLED: (msg) => {
      state.enabled = Boolean(msg.enabled);
      if (state.enabled) {
        startScaleEffect();
      } else {
        reset();
      }
      return currentState();
    },
    HIGHLIGHT: () => (state.enabled ? { ...currentState(), count: highlight() } : currentState()),
    HIDE: () => (state.enabled ? { ...currentState(), count: hide() } : currentState()),
    RESET: () => ({ ...currentState(), count: reset() }),
    START_SCALE: () => {
      if (state.enabled) startScaleEffect();
      return currentState();
    },
    STOP_SCALE: () => {
      stopScaleEffect();
      return currentState();
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 后台广播的音乐状态：音乐开始/停止时更新播放基准
    if (msg?.type === "MUSIC_STATE") {
      setMusicState(msg);
      return false;
    }
    const handler = handlers[msg?.type];
    if (!handler) return false;
    sendResponse(handler(msg));
    return false;
  });
})();
