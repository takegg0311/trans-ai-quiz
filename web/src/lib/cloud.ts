/** Cookie 認証を使う変更操作に、CSRF 対策の独自ヘッダーを付ける。 */
export async function cloudRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Quiz-Request', '1');
  return fetch(path, { ...init, headers });
}

export async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(body?.detail ?? '通信に失敗しました。');
  }
  return response;
}
