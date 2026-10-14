/**
 * PengYouDeJiu - 尺寸变换系数计算函数（占位实现）
 *
 * 约定：
 *   输入：time   当前时间（毫秒，已减去点击"开始尺寸变换"的时刻）
 *        depth  该元素的层数（自下而上：无子元素的为 0，逐层向上 +1；
 *               层数越大代表越靠近根元素）
 *        amount 缩放强度（由 popup 配置，默认 0.1，任意数字均可）
 *   输出：{ width, height } 两个乘数，用于缩放元素的宽 / 高
 *
 * 注意：下方仅为占位示例，方便观察变换是否生效；
 *       请根据想要的视觉效果自行调整函数内部的算法。
 *
 * @param {number} time 相对时间（毫秒）
 * @param {number} depth 元素层数
 * @param {number} amount 缩放强度
 * @returns {{ width: number, height: number }} 宽度乘数、高度乘数
 */

function beatToScale(beat, depth, amount){
  const offset = Math.PI;
  // 层数越大（越靠近根元素）影响越小：叶子层数 0 波动最大，根元素几乎不缩放
  const damp = 1 / Math.pow(2, depth);
  const height = 1 + damp * amount * (2 / Math.PI * Math.atan(3*Math.sin(beat*Math.PI - offset)));
  const width = 1 / height;
  return { width, height };
}


window.__PYJ_computeScale = function (time, depth, amount = 0.1) {
  // —— 占位示例：用时间驱动正弦波，输出随 amount 变化的乘数 ——
  const bpm = 130; // 每分钟心跳次数，用于计算时间缩放（默认 140）
  const beat = bpm * time / 60000; // 60000 毫秒 = 1 分钟，1 分钟 = bpm 心跳，1 心跳 = 1 / bpm 秒 // 秒
  return beatToScale(beat*2, depth, amount);

  // —— 也可以先返回固定值，方便调试： ——
  // return { width: 1, height: 1 };
};
