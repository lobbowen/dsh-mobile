package lobos.os

/**
 * 指数退避的**唯一实现**（复检 C5：此前 SupervisorPolicy 与 AdbClientRunner 各写一份）。
 *
 * 语义：`baseMs * 2^attempt`，封顶 `maxMs`；`attempt` 夹在 `0..maxShift`
 * （Kotlin 的 shl 对越界/负数移位会取模，不能依赖调用方传值合法）。
 */
object Backoff {
    fun exponential(attempt: Int, baseMs: Long, maxMs: Long, maxShift: Int = 5): Long =
        minOf(baseMs shl attempt.coerceIn(0, maxShift), maxMs)
}
