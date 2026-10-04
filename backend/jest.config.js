module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 120000,
  /**
   * 方案 5.11「可维护性」：领域规则（评分、抽取、情绪）单元测试覆盖率 ≥ 80%。
   * 门槛只作用在 src/domain 上（其他层由 e2e 覆盖，不纳入这条要求），
   * 带 --coverage 时生效（npm run test:coverage -w backend），低于阈值直接失败，
   * 免得「覆盖率」变成每次人工跑一眼的数字。
   */
  coverageThreshold: {
    './src/domain/': {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
