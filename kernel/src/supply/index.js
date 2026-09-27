'use strict';
// C 层（共享开发环境）在内核侧的两半：清单（内容通道）+ 物化（机制）。
module.exports = { manifest: require('./manifest'), materialize: require('./materialize') };
