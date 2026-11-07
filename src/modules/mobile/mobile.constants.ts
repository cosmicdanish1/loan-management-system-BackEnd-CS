/** Name of the separate, small TypeORM connection used only by the mobile module (ES-222). */
export const MOBILE_DS = 'mobile';

/** Claims of a member access token. Staff tokens carry neither `typ` nor `aud`. */
export const MEMBER_TOKEN_TYPE = 'member';
export const MEMBER_TOKEN_AUDIENCE = 'mobile';

/** Strategy name for member tokens (staff tokens use 'jwt'). */
export const MEMBER_JWT_STRATEGY = 'jwt-member';

export const MOBILE_OFFICE_TZ = 'Asia/Kolkata';
