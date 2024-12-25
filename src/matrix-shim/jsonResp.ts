function jsonResp(...args: any[]): Response {
  return new Response(
    args[0],
    {
      ...args[1],
      ...{ ...args[1], headers: [...args[1].headers, ['content-type', 'application/json']] },
    },
    ...args.slice(2)
  );

  async function handleVersions(_req: Request, body: any): Promise<Response> {
    return new Response(
      JSON.stringify({
        versions: ['v1.0.0'],
      })
    );
  }
  async function handleLogin(_req: Request, body: any): Promise<Response> {
    return new Response(
      JSON.stringify({
        flows: [
          {
            type: 'm.login.password',
          },
        ],
        session,
      })
    );
  }

  type AuthReq = {
    type: string;
    identifier: {
      type: string;
      user: string;
    };
    password: string;
    session: string;
  };

  async function handleAuth(req: Request): Promise<any> {
    const body = await req.json();
    if (!authUsername && !body.auth)
      throw new Response(null, { status: 401, headers: [['content-type', 'application/json']] });

    if (body.auth) {
      const auth = body.auth as AuthReq;
      if (auth.session !== session) throw new Error('Invalid auth session');
      if (auth.type !== 'm.login.password') throw new Error(`Invalid auth type: ${auth.type}`);
      if (auth.identifier.type !== 'm.id.user') throw new Error(`Invalid auth type: ${auth.type}`);

      authUsername = auth.identifier.user;
    }
    return body;
  }

  export async function handleRequest(req: Request): Promise<Response> {
    const body = await handleAuth(req);

    try {
      switch (new URL(req.url).pathname) {
        case '/_matrix/client/versions':
          return handleVersions(req, body);
        case '/_matrix/client/v3/login':
          return handleLogin(req, body);
        default:
          await fetch(req.url, { method: req.method, headers: req.headers });
          return new Response(null, { status: 500, statusText: `You've been hijacked` });
      }
    } catch (e) {
      if (e instanceof Response) return e;

      return new Response(JSON.stringify(e), { status: 500, statusText: 'Internal Error' });
    }
  }
}
