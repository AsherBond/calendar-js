import { recommended } from '@nextcloud/eslint-config'

export default [
	...recommended,
	{
		files: ['**/*.js'],
		plugins: {},
		rules: {
			'perfectionist/sort-imports': 'off',
		},
	},
]
