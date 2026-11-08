# Synthetic agreements

- Use strict equality except null.
- Never use var
  except in generated compatibility shims.
- Do not use console except warn.
- Functions must have at most 4 parameters.
- Components should have a single reason to change.
- When retrying a payment request, reuse the idempotency key across attempts.
- Keep domain calculations independent from UI components.
- В тестах допустим console.log, в production коде запрещён.
