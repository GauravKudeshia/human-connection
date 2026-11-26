export const supplyJoins = `
 FROM mp_host_profiles h
 JOIN mp_users u ON u.id=h.user_id
 JOIN mp_host_verifications v ON v.user_id=h.user_id
 JOIN mp_certifications c ON c.host_id=h.user_id`;
export const approvedSupply = `h.status='APPROVED' AND u.status='ACTIVE'
 AND v.status='VERIFIED' AND v.adult_verified=1 AND v.jurisdiction='US' AND v.payout_status='ELIGIBLE'
 AND c.status='APPROVED'
 AND EXISTS(SELECT 1 FROM mp_user_roles WHERE user_id=h.user_id AND role='host')`;
export const hostLanguageRows =
  "json_each(CASE WHEN json_valid(h.languages) THEN h.languages ELSE '[]' END) AS language";
export const normalizedLanguageSql = `CASE language.type
 WHEN 'object' THEN lower(json_extract(language.value,'$.tag'))
 WHEN 'text' THEN CASE lower(trim(language.value))
   WHEN 'english' THEN 'en' WHEN 'spanish' THEN 'es'
   ELSE lower(trim(language.value)) END END`;
import { stylesFor } from "../catalog.mjs";
import { text } from "./errors.mjs";

export const hostInterestsSql =
  "COALESCE((SELECT interests FROM mp_host_interests WHERE host_id=h.user_id),'[]')";

export function hostSearch(queryValue, experience) {
  if (!queryValue) return { condition: "", parameters: [] };
  const query = text(queryValue, 100);
  const folded = query.toLowerCase();
  const matchingStyles = stylesFor(experience)
    .filter(({ id, name }) => id.includes(folded) || name.toLowerCase().includes(folded))
    .map(({ id }) => id);
  return {
    condition: ` AND (instr(lower(h.display_name),lower(?))>0 OR instr(lower(h.biography),lower(?))>0
      OR EXISTS(SELECT 1 FROM json_each(${hostInterestsSql}) topic WHERE instr(lower(topic.value),lower(?))>0)
      OR EXISTS(SELECT 1 FROM json_each(h.styles) style WHERE style.value IN (SELECT value FROM json_each(?))))`,
    parameters: [query, query, query, JSON.stringify(matchingStyles)],
  };
}

