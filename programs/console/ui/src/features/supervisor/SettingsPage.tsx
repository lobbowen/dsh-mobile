/**
 * 设置（supervisor settings）— 容器页
 * ============================================================================
 * 结构（2026-09 解耦重构）：本页只做排版拼接，不再持有任何数据加载/状态逻辑。
 * 两个语义独立的区块各自是自治组件——各自加载、各自失败、互不拖累：
 *   - AccessCard   访问（lan-panel / access-key）
 *   - RegistryCard 镜像源（registry：探测/候选/手动固定）
 *   - AboutCard    关于（内核版本 + 简介 + 检查更新，置于最底部）
 * 修复的错误耦合：旧实现一个 load() 用 Promise.all 拉全部端点后统一 setState，
 * 任一端点慢/失败会让整个设置页所有区块停在初始兜底态（启动开关看不见、
 * 镜像源列表空白）——现已按区块彻底拆分，各自独立请求与失败隔离。
 * ============================================================================
 */
import { AccessCard } from "./settings/AccessCard";
import { RegistryCard } from "./settings/RegistryCard";
import { AboutCard } from "./settings/AboutCard";

export function SettingsPage() {
  return (
    <div className="grid content-start gap-4">
      <AccessCard />
      <RegistryCard />
      <AboutCard />
    </div>
  );
}
