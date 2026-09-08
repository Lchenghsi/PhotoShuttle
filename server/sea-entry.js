// SEA（单文件 exe）专用入口：构建脚本会先生成 embedded.gen.js 把 H5 静态资源
// 以字符串形式打进包里；index.js 在响应请求时按需读取该全局变量。
// 注意：这里必须用“运行时读取”，静态 import 的求值顺序保证不了赋值先于 index.js。
import embedded from './embedded.gen.js';
globalThis.EMBEDDED_PUBLIC = embedded;
import './index.js';
