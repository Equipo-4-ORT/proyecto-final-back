const js = require("@eslint/js");
const globals = require("globals");

const sharedRules = {
    "no-unused-vars": "warn",
    "no-console": "off",
    "func-style": ["error", "expression"],
    "prefer-arrow-callback": "error",
};

module.exports = [
    {
        ignores: ["node_modules/**"],
    },
    js.configs.recommended,
    {
        files: ["src/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
            },
        },
        rules: sharedRules,
    },
    {
        files: ["tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        rules: sharedRules,
    },
];
