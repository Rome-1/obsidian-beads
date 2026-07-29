import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: [
			"main.js",
			"esbuild.config.mjs",
			"version-bump.mjs",
			"eslint.config.mjs",
		],
	},
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// "Beads" (the product) and "bd" (the CLI binary) are proper nouns;
			// the sentence-case rule wants "beads"/"Bd", which is wrong here.
			"obsidianmd/ui/sentence-case": "off",
		},
	},
);
