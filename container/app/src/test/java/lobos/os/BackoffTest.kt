package lobos.os

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun `指数增长并封顶`() {
        assertEquals(1_000L, Backoff.exponential(0, 1_000L, 30_000L))
        assertEquals(2_000L, Backoff.exponential(1, 1_000L, 30_000L))
        assertEquals(16_000L, Backoff.exponential(4, 1_000L, 30_000L))
        assertEquals(30_000L, Backoff.exponential(5, 1_000L, 30_000L))
        assertEquals(30_000L, Backoff.exponential(9, 1_000L, 30_000L))
    }

    @Test fun `负数与超界 attempt 被夹住`() {
        assertEquals(1_000L, Backoff.exponential(-3, 1_000L, 30_000L))
        assertEquals(30_000L, Backoff.exponential(99, 1_000L, 30_000L))
    }
}
