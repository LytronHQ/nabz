import { json } from '@sveltejs/kit';
import { type ZodTypeAny } from 'zod';

export default class BaseEntityValidator {
	constructor(
		public schema: ZodTypeAny,
		public item: any
	) {}

	get isValid() {
		return this.schema.safeParse(this.item).success;
	}

	get validationErrors() {
		const parsed = this.schema.safeParse(this.item);
		if (parsed.success) {
			return undefined;
		}

		return parsed.error.issues.map((issue) => {
			return {
				code: issue.code,
				message: issue.message,
				field: issue.path.join('.')
			};
		});
	}

	public getInvalidDataResponse() {
		return json(
			{
				success: false,
				message: 'Invalid data. Please try again.',
				errors: this.validationErrors
			},
			{ status: 400 }
		);
	}
}
