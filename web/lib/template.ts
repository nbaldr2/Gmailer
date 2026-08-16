export interface RecipientRow {
  email: string;
  [key: string]: string;
}

const VAR_RE = /\[-([a-z0-9_]+)-\]/gi;

const RANDOM_GENERATORS: Record<string, () => string> = {
  randomstring: () => {
    const a = Math.random().toString(36).substring(2, 10);
    const b = Math.random().toString(36).substring(2, 10);
    return a + b;
  },
  randomnumber: () => String(Math.floor(Math.random() * 1000000000)),
  randomletters: () => {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return Array.from({ length: 10 }, () => letters[Math.floor(Math.random() * 26)]).join("");
  },
  randomds: () => {
    const chars = "0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
    return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  },
  randomuuid: () => crypto.randomUUID(),
  randomhex: () => {
    let h = "";
    for (let i = 0; i < 16; i++) h += Math.floor(Math.random() * 16).toString(16);
    return h;
  },
  shortid: () => Math.random().toString(36).substring(2, 8),
  randomcolor: () => "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
  randompid: () => String(Math.floor(Math.random() * 32768) + 1),
  randomu: () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789_-";
    return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  },
};

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function resolveTemplate(
  input: string,
  recipient: RecipientRow,
  now: Date = new Date(),
): string {
  const [emailUser = "", emailDomain = ""] = recipient.email.split("@");
  const fullname =
    recipient.fullname?.trim() ||
    [recipient.firstname, recipient.lastname]
      .filter((s) => s?.trim())
      .join(" ");
  const vars: Record<string, string> = {
    email: recipient.email,
    emailuser: emailUser,
    emaildomain: emailDomain,
    firstname: recipient.firstname ?? "",
    lastname: recipient.lastname ?? "",
    fullname: fullname ?? "",
    company: recipient.company ?? "",
    jobtitle: recipient.jobtitle ?? "",
    phone: recipient.phone ?? "",
    address: recipient.address ?? "",
    city: recipient.city ?? "",
    country: recipient.country ?? "",
    domain: recipient.domain ?? "",
    date: now.toISOString().slice(0, 10),
    timestamp: String(Math.floor(now.getTime() / 1000)),
    unixtime: String(now.getTime()),
    year: String(now.getFullYear()),
  };
  return input.replace(VAR_RE, (match, key: string) => {
    const k = key.toLowerCase();
    const gen = RANDOM_GENERATORS[k];
    if (gen) return gen();
    const value = vars[k];
    return value !== undefined ? value : match;
  });
}
