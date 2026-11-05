import {readState,errorResponse} from '../../../lib/store';
export const dynamic='force-dynamic';
export async function GET(){try{return Response.json(await readState(),{headers:{'Cache-Control':'no-store'}});}catch(error){return errorResponse(error);}}
