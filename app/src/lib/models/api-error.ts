export default class ApiError {
	constructor(
		public success: boolean,
		public message: string,
		public status: number,
		public errors?: Array<{ field: string; message: string }>
	) {}
}
