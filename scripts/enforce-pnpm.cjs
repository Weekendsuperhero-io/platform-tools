const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("This repository uses pnpm. Use `pnpm install` and `pnpm run ...`, not npm.");
  process.exit(1);
}
