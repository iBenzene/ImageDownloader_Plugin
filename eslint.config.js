import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,mjs,js}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2022,
            },
        },
        rules: {
            // 0) 强制使用 4 空格缩进与单行最大长度 120 字符
            'indent': ['error', 4, { 'SwitchCase': 1 }],
            'max-len': ['error', {
                'code': 120,
                'tabWidth': 4,
                'ignoreUrls': true,
                'ignoreRegExpLiterals': true,
            }],
            'max-statements-per-line': ['error', { 'max': 2 }],

            // 1) JS/TS 代码统一使用单引号, 内部含单引号时允许用双引号避免转义
            'quotes': ['error', 'single', { 'avoidEscape': true }],

            // 2) 使用箭头函数, 且单参数不要有括号
            'func-style': ['error', 'expression'],
            'prefer-arrow-callback': ['error', { 'allowNamedFunctions': false, 'allowUnboundThis': true }],
            'arrow-parens': ['error', 'as-needed'],

            // 3) 结尾要有分号
            'semi': ['error', 'always'],

            // 4) 文件末尾留且只留一个空行
            'eol-last': ['error', 'always'],
            'no-multiple-empty-lines': ['error', { 'max': 1, 'maxEOF': 0 }],

            // 5) if 语句与代码块规则
            'curly': ['error', 'all'], // 始终需要大括号
            'brace-style': ['error', '1tbs', { 'allowSingleLine': true }], // 强制 1TBS 风格, 允许单行
            'block-spacing': ['error', 'always'], // 单行块内加空格
            'object-curly-spacing': ['error', 'always'], // 对象字面量内加空格

            // 其他推荐规则
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off',
        },
    },
];
