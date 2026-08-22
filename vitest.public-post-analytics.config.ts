import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: [
      'apps/backend/src/public-api/routes/v1/public.integrations.controller.post-analytics.spec.ts',
      'libraries/nestjs-libraries/src/database/prisma/posts/posts.service.post-analytics.spec.ts',
    ],
  },
});
