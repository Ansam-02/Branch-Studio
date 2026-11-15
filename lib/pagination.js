export function parsePagination(params) {
  const pageText = params.get('page') ?? '1';
  const limitText = params.get('limit') ?? '50';
  if (!/^\d+$/.test(pageText) || !/^\d+$/.test(limitText)) return null;
  const page = Number(pageText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationSummary({ page, limit }, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}
