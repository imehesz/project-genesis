/** Absolute URL of a file in public/, honouring the deploy base (e.g. /games/project-genesis/). */
export const asset = (path: string) => import.meta.env.BASE_URL + path.replace(/^\//, '');
