"""The conformance suite, as a stdlib unittest.

Nothing has to be installed to check the SDK. pytest picks these up too.
"""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path

from .runner import load_cases, run_case
from .sdk_adapter import factory

CASES_DIR = Path(__file__).resolve().parents[2] / "conformance" / "cases"


class ConformanceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        # IsolatedAsyncioTestCase runs the loop in debug mode, which reports any
        # await over 100ms as a slow callback. Every case here is a long poll
        # deliberately waiting, so that warning fires constantly and says
        # nothing. Turning it off keeps a green run readable.
        asyncio.get_running_loop().set_debug(False)

    async def test_conformance(self) -> None:
        cases = load_cases(CASES_DIR)
        self.assertTrue(cases, f"no cases found in {CASES_DIR}")

        for case in cases:
            with self.subTest(case=case["id"]):
                failures = await run_case(case, factory)
                if not failures:
                    continue
                lines = [f"{case['guarantee']} — {case['title']}"]
                lines += [f"  · {failure}" for failure in failures]
                # Printed only on failure: at the moment someone is deciding
                # whether this case is worth keeping, they should be reading
                # what breaks in production if it goes.
                lines.append(f"  why: {case['why']}")
                self.fail("\n".join(lines))

    async def test_runner_detects_a_mismatch(self) -> None:
        """Keeps the suite honest.

        A runner that has never failed a case is not a tested runner: it might
        report PASS because it checks nothing. The TypeScript side proves this
        with a deliberately naive bot; here it is cheaper to take a passing
        case, make one expectation impossible, and require the runner to
        notice.
        """
        cases = {case["id"]: case for case in load_cases(CASES_DIR)}
        target = cases.get("g2-offset-advances-when-handler-throws")
        self.assertIsNotNone(target, "g2 is missing; this guard needs it")

        # The first poll cannot possibly carry offset 999.
        target["exchanges"][0]["expect"]["body"]["offset"] = 999

        failures = await run_case(target, factory)
        self.assertTrue(
            failures,
            "the runner passed a case whose first expectation was impossible; "
            "it is not checking requests",
        )


if __name__ == "__main__":
    unittest.main()
