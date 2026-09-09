"""Runs the shared conformance cases against the Python SDK.

The cases in ../../conformance/cases are data shared by all three SDKs; only
this runner is Python's. Where the TypeScript runner is a CLI and the Go one is
``go test``, this is ``unittest`` — stdlib, so nothing has to be installed to
check the SDK. Same cases, same verdicts, different shape.
"""
