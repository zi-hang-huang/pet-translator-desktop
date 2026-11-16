/**
 * 球的大小档位 —— **唯一的真值来源**。
 *
 * 这个数组以前抄了三份（右键菜单、托盘菜单、设置面板），加档位时漏改一处，
 * 就会出现「右键能选 0.2x、设置里没有」这种各说各话。统一放这儿：
 * 主进程两个菜单 require 它，面板通过 `ball:info` 拿同一份。
 *
 * 0.2 / 0.4 是后加的极小档：0.2x ≈ 19px、0.4x ≈ 38px，
 * 适合想让球缩到几乎看不见、只在角落留个点的人。
 */

const SCALES = Object.freeze([0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.5, 1.8]);

const MIN_SCALE = SCALES[0];
const MAX_SCALE = SCALES[SCALES.length - 1];

module.exports = { SCALES, MIN_SCALE, MAX_SCALE };
