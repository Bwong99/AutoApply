There may be other agents working at the same time as you. Be cognisant of this when making changes and performing git operations. Do not overwrite other agents' changes.

When making changes, ask me any questions you need about my priorities, preferences, purpose, etc. Feel free to discuss trade-offs with different implementation approaches, alternative plans, etc. Ensure your changes DO NOT ALTER ANY OTHER pre-existing functionality - that is, everything that was working before the change should continue working after the change.

When planning your approach/implementation, you must maintain the AutoApply autofill priorities:
1. Autofill MUST NOT fall for AI honeypots/tricks/traps
2. Every autofill must be as accurate as possible
3. Autofill must complete fast
4. Autofill must use little to no background resources and performance should not be too impacted when using the autofill
5. Autofill AI must keep token usage minimal
