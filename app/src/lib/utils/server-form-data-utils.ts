import { format } from '@formkit/tempo';

export async function getFormData(data: any) {
	const fd = new FormData();
	for (const [key, val] of Object.entries(data)) {
		if (val === undefined || val === null) {
		} else if (val instanceof File) {
			fd.append(key, val);
		} else if (val instanceof FileList) {
			fd.append(key, val[0]);
		} else if (val instanceof Date) {
			fd.append(key, format(val, 'YYYY-MM-DD'));
		} else if (Array.isArray(val)) {
			// Arrays of objects (e.g. maintenance windows) can't be comma-joined —
			// send them as JSON; plain scalar arrays (e.g. zones) stay comma-joined.
			if (val.length > 0 && typeof val[0] === 'object') {
				fd.append(key, JSON.stringify(val));
			} else {
				fd.append(key, val.join(','));
			}
		} else if (typeof val === 'object') {
			fd.append(key, JSON.stringify(val));
		} else {
			fd.append(key, val as any);
		}
	}

	return fd;
}
