// Shizuku UserService 接口 —— 由 Shizuku server 在**自己的进程（shell/root 身份）**里实例化。
// 因此实现体里的 Runtime.exec 天然就是 shell uid(2000)。见 ADR-0003（Shizuku 为必备能力）。
package com.example.nodecontainer.shizuku;

import android.os.Bundle;

interface IRemoteShell {

    // Shizuku server 约定的保留事务号：调用方死亡时 server 用它回收本 user service。
    void destroy() = 16777114;

    // 执行一次命令；返回 Bundle{ exitCode:int, output:String, uid:int }
    Bundle exec(String cmd, in String[] args, long timeoutMs) = 1;
}
