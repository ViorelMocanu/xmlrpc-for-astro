import { defineConfig, globalIgnores } from "eslint/config";
import jsdoc from "eslint-plugin-jsdoc";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const ignoreArray = [".astro/**", ".cache/**", ".github/**", ".idea/**", ".netlify/**", ".vercel/**", "build/**", "coverage/**", "demo/**", "dev-dist/**", "dist/**", "node_modules/**", "static/**"];

export default defineConfig([
	globalIgnores(ignoreArray),
	{
		files: ["**/*.ts"],
		ignores: ignoreArray,
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaFeatures: { modules: true },
				ecmaVersion: "latest",
			},
		},
		plugins: {
			"@typescript-eslint": ts,
			ts,
			jsdoc,
		},
		rules: {
			...ts.configs["eslint-recommended"].rules,
			...ts.configs["recommended"].rules,
			...jsdoc.configs["flat/recommended"].rules,
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "error",
			"indent": ["error", "tab", { SwitchCase: 1 }],
			"linebreak-style": ["error", "unix"],
			"brace-style": ["error", "1tbs", { allowSingleLine: true }],
			"sort-imports": "warn",
			"key-spacing": ["error", { beforeColon: false, afterColon: true }],
			"keyword-spacing": ["error", { before: true, after: true }],
			"no-console": "warn",
			"no-dupe-args": "error",
			"no-duplicate-imports": "error",
			"no-mixed-spaces-and-tabs": ["error", "smart-tabs"],
			"no-unexpected-multiline": "error",
			"object-property-newline": ["error", { allowAllPropertiesOnSameLine: true }],
			"semi": ["warn", "always", { omitLastInOneLineBlock: true }],
			"semi-style": ["error", "last"],
			"semi-spacing": ["error", { before: false, after: true }],
			"space-before-blocks": "error",
			"space-in-parens": ["warn", "never"],
			"template-curly-spacing": "warn",
			"wrap-regex": "warn",
			"jsdoc/require-description": "off",
			"jsdoc/require-returns": "off",
			"jsdoc/require-param-description": "off",
			"jsdoc/require-param-type": "off",
			"@typescript-eslint/ban-ts-comment": "warn",
		},
	},
	{
		ignores: [...ignoreArray],
	},
]);
