"""
Grok API retry utilities.

Provides configurable retry behavior with:
- exponential backoff + decorrelated jitter
- Retry-After support
- retry budget control
"""

import asyncio
import random
from functools import wraps
from typing import Any, Callable, Optional

from app.core.config import get_config
from app.core.exceptions import UpstreamException
from app.core.logger import logger


class RetryContext:
    """Retry execution context."""

    @staticmethod
    def _safe_int_config(key: str, default: int) -> int:
        value = get_config(key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(
                f"Invalid config {key}={value!r}, fallback to default {default}"
            )
            return default

    @staticmethod
    def _safe_float_config(key: str, default: float) -> float:
        value = get_config(key, default)
        try:
            return float(value)
        except (TypeError, ValueError):
            logger.warning(
                f"Invalid config {key}={value!r}, fallback to default {default}"
            )
            return default

    @staticmethod
    def _safe_status_codes(key: str, default: list[int]) -> list[int]:
        value = get_config(key, default)

        if isinstance(value, str):
            parts = [p.strip() for p in value.split(",") if p.strip()]
            parsed: list[int] = []
            for part in parts:
                try:
                    parsed.append(int(part))
                except (TypeError, ValueError):
                    logger.warning(f"Invalid status code in {key}: {part!r}, ignored")
            if parsed:
                return parsed

        if isinstance(value, (list, tuple, set)):
            parsed: list[int] = []
            for item in value:
                try:
                    parsed.append(int(item))
                except (TypeError, ValueError):
                    logger.warning(f"Invalid status code in {key}: {item!r}, ignored")
            if parsed:
                return parsed

        logger.warning(f"Invalid config {key}={value!r}, fallback to default {default}")
        return list(default)

    def __init__(self):
        self.attempt = 0
        self.max_retry = max(0, self._safe_int_config("retry.max_retry", 3))
        self.retry_codes = self._safe_status_codes(
            "retry.retry_status_codes", [401, 429, 403]
        )
        self.last_error: Optional[Exception] = None
        self.last_status: Optional[int] = None
        self.total_delay = 0.0
        self.retry_budget = max(
            0.0,
            self._safe_float_config("retry.retry_budget", 90.0),
        )

        self.backoff_base = max(
            0.0,
            self._safe_float_config("retry.retry_backoff_base", 0.5),
        )
        self.backoff_factor = max(
            1.0,
            self._safe_float_config("retry.retry_backoff_factor", 2.0),
        )
        self.backoff_max = max(
            self.backoff_base,
            self._safe_float_config("retry.retry_backoff_max", 30.0),
        )

        # decorrelated jitter state
        self._last_delay = self.backoff_base

    def should_retry(self, status_code: int) -> bool:
        """Return whether current request should retry."""
        if self.attempt >= self.max_retry:
            return False
        if status_code not in self.retry_codes:
            return False
        if self.total_delay >= self.retry_budget:
            return False
        return True

    def record_error(self, status_code: int, error: Exception):
        """Record an error for retry accounting."""
        self.last_status = status_code
        self.last_error = error
        self.attempt += 1

    def calculate_delay(
        self, status_code: int, retry_after: Optional[float] = None
    ) -> float:
        """Calculate delay before next retry."""
        if retry_after is not None and retry_after > 0:
            delay = min(retry_after, self.backoff_max)
            self._last_delay = delay
            return delay

        if status_code == 429:
            delay = random.uniform(self.backoff_base, self._last_delay * 3)
            delay = min(delay, self.backoff_max)
            self._last_delay = delay
            return delay

        exp_delay = self.backoff_base * (self.backoff_factor**self.attempt)
        delay = random.uniform(0, min(exp_delay, self.backoff_max))
        return delay

    def record_delay(self, delay: float):
        """Record accumulated delay."""
        self.total_delay += delay


def extract_retry_after(error: Exception) -> Optional[float]:
    """Extract Retry-After from upstream error details."""
    if not isinstance(error, UpstreamException):
        return None

    details = error.details or {}

    retry_after = details.get("retry_after")
    if retry_after is not None:
        try:
            return float(retry_after)
        except (ValueError, TypeError):
            pass

    headers = details.get("headers", {})
    if isinstance(headers, dict):
        retry_after = headers.get("Retry-After") or headers.get("retry-after")
        if retry_after is not None:
            try:
                return float(retry_after)
            except (ValueError, TypeError):
                pass

    return None


async def retry_on_status(
    func: Callable,
    *args,
    extract_status: Callable[[Exception], Optional[int]] = None,
    on_retry: Callable[[int, int, Exception, float], None] = None,
    **kwargs,
) -> Any:
    """Generic retry wrapper by extracted status code."""
    ctx = RetryContext()

    if extract_status is None:

        def extract_status(e: Exception) -> Optional[int]:
            if isinstance(e, UpstreamException):
                if e.details and "status" in e.details:
                    return e.details["status"]
                return getattr(e, "status_code", None)
            return None

    while ctx.attempt <= ctx.max_retry:
        try:
            result = await func(*args, **kwargs)

            if ctx.attempt > 0:
                logger.info(
                    f"Retry succeeded after {ctx.attempt} attempts, "
                    f"total delay: {ctx.total_delay:.2f}s"
                )

            return result

        except Exception as e:
            status_code = extract_status(e)

            if status_code is None:
                logger.error(f"Non-retryable error: {e}")
                raise

            ctx.record_error(status_code, e)

            if ctx.should_retry(status_code):
                retry_after = extract_retry_after(e)
                delay = ctx.calculate_delay(status_code, retry_after)

                if ctx.total_delay + delay > ctx.retry_budget:
                    logger.warning(
                        f"Retry budget exhausted: {ctx.total_delay:.2f}s + {delay:.2f}s > {ctx.retry_budget}s"
                    )
                    raise

                ctx.record_delay(delay)

                logger.warning(
                    f"Retry {ctx.attempt}/{ctx.max_retry} for status {status_code}, "
                    f"waiting {delay:.2f}s (total: {ctx.total_delay:.2f}s)"
                    + (f", Retry-After: {retry_after}s" if retry_after else "")
                )

                if on_retry:
                    on_retry(ctx.attempt, status_code, e, delay)

                await asyncio.sleep(delay)
                continue

            if status_code in ctx.retry_codes:
                logger.error(
                    f"Retry exhausted after {ctx.attempt} attempts, "
                    f"last status: {status_code}, total delay: {ctx.total_delay:.2f}s"
                )
            else:
                logger.error(f"Non-retryable status code: {status_code}")

            raise


def with_retry(
    extract_status: Callable[[Exception], Optional[int]] = None,
    on_retry: Callable[[int, int, Exception, float], None] = None,
):
    """Retry decorator."""

    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            return await retry_on_status(
                func,
                *args,
                extract_status=extract_status,
                on_retry=on_retry,
                **kwargs,
            )

        return wrapper

    return decorator


__all__ = [
    "RetryContext",
    "retry_on_status",
    "with_retry",
    "extract_retry_after",
]
