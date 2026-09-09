/** Shows a North American number as `(555) 010-0100`; anything else as typed. */
export function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const national =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;

  if (national.length !== 10) {
    return phone;
  }

  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}
