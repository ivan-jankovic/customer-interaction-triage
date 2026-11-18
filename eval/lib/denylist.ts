// Names of real Czech and Slovak telecom operators and brands. Generated messages must
// not contain any of them (mission: no imitation of a real company). Matched as whole
// words after removing diacritics. Names that are also ordinary words ("orange" light on
// a router, "Digi" as a nickname) are matched case-sensitively to avoid false positives;
// names that collide with common Czech/Slovak words or first names (e.g. "podá", "Juro")
// are left out, accepting a small gap over a noisy check.
interface DeniedName {
  name: string;
  caseSensitive?: boolean;
}

export const REAL_OPERATOR_DENYLIST: readonly DeniedName[] = [
  { name: "O2" },
  { name: "T-Mobile" },
  { name: "Vodafone" },
  { name: "Orange", caseSensitive: true },
  { name: "Slovak Telekom" },
  { name: "Telekom", caseSensitive: true },
  { name: "Magio" },
  { name: "4ka" },
  { name: "CETIN" },
  { name: "Nej.cz" },
  { name: "UPC" },
  { name: "Kaktus", caseSensitive: true },
  { name: "Sazkamobil" },
  { name: "SAZKA" },
  { name: "Tesco Mobile" },
  { name: "Odorik" },
  { name: "Starnet" },
  { name: "Skylink" },
  { name: "Telly", caseSensitive: true },
  { name: "Digi", caseSensitive: true },
  { name: "Lycamobile" },
];

const stripMarks = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "");
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function deniedNamesIn(text: string): string[] {
  const plain = stripMarks(text);
  return REAL_OPERATOR_DENYLIST.filter(({ name, caseSensitive }) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escape(stripMarks(name))}($|[^\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu").test(plain),
  ).map((d) => d.name);
}
