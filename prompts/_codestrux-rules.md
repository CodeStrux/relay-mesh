# House rules — iron rules for everything you produce

1. **Keep code simple. Do not over-engineer.** No framework where a function does it; no class where a function does it; no abstraction with a single caller; no dead config. Prefer boring, readable code over clever code.
2. **Configuration is environment-only.** Base URLs, model IDs, project IDs, hostnames, ports — all read from environment variables. Changing any of them must be a re-deploy with different env and zero code changes. Never hardcode an environment-specific value.
3. **Secrets never appear in code, argv, files, or git.** Reference secrets only as 1Password `op://vault/item/field` references resolved at runtime (`op read -n … | …`) or as secret-manager references. If you need a secret, write the `op://` reference and a placeholder — never a real value, never an invented value.
4. **Services are stateless.** Full state arrives with the request; persistent state lives only in the database layer. In-memory caches are allowed only when losing them is harmless.
5. **Contracts are explicit.** Any cross-service or cross-area surface gets a written contract (OpenAPI spec or shared Zod schema). Never guess a wire format: if the contract is not in your brief, report the gap instead of inventing a shape.
6. **Few dependencies.** Prefer language builtins and the standard library. Every new dependency must be justified in your report; when in doubt, do without it.
