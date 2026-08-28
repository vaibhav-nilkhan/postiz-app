import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: [
      'libraries/nestjs-libraries/src/database/prisma/connection-attempt/*.spec.ts',
      'apps/backend/src/api/routes/no.auth.integrations.controller.connection-attempt.spec.ts',
      'apps/backend/src/services/auth/postify.api-key.auth.middleware.spec.ts',
      'apps/backend/src/public-api/routes/v1/postify.connection-attempts.controller.spec.ts',
      'apps/backend/src/public-api/routes/v1/public.integrations.controller.publication-attempt.spec.ts',
    ],
  },
});
