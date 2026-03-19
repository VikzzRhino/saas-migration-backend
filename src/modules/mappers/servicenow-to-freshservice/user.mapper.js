// src/modules/mappers/servicenow-to-freshservice/user.mapper.js

const TIMEZONE_MAP = {
  'Pacific/Midway': 'Midway Island',
  'Pacific/Pago_Pago': 'American Samoa',
  'Pacific/Honolulu': 'Hawaii',
  'America/Juneau': 'Alaska',
  'America/Los_Angeles': 'Pacific Time (US & Canada)',
  'America/Tijuana': 'Tijuana',
  'America/Phoenix': 'Arizona',
  'America/Mazatlan': 'Mazatlan',
  'America/Denver': 'Mountain Time (US & Canada)',
  'America/Guatemala': 'Central America',
  'America/Chicago': 'Central Time (US & Canada)',
  'America/Chihuahua': 'Chihuahua',
  'America/Mexico_City': 'Mexico City',
  'America/Monterrey': 'Monterrey',
  'America/Regina': 'Saskatchewan',
  'America/Bogota': 'Bogota',
  'America/New_York': 'Eastern Time (US & Canada)',
  'America/Indiana/Indianapolis': 'Indiana (East)',
  'America/Lima': 'Lima',
  'America/Guayaquil': 'Quito',
  'America/Halifax': 'Atlantic Time (Canada)',
  'America/Caracas': 'Caracas',
  'America/Guyana': 'Georgetown',
  'America/La_Paz': 'La Paz',
  'America/Puerto_Rico': 'Puerto Rico',
  'America/Santiago': 'Santiago',
  'America/St_Johns': 'Newfoundland',
  'America/Sao_Paulo': 'Brasilia',
  'America/Argentina/Buenos_Aires': 'Buenos Aires',
  'America/Montevideo': 'Montevideo',
  'America/Godthab': 'Greenland',
  'Atlantic/South_Georgia': 'Mid-Atlantic',
  'Atlantic/Azores': 'Azores',
  'Atlantic/Cape_Verde': 'Cape Verde Is.',
  'Africa/Casablanca': 'Casablanca',
  'Europe/Dublin': 'Dublin',
  'Europe/London': 'London',
  'Africa/Monrovia': 'Monrovia',
  'Etc/UTC': 'UTC',
  'UTC': 'UTC',
  'Europe/Amsterdam': 'Amsterdam',
  'Europe/Belgrade': 'Belgrade',
  'Europe/Berlin': 'Berlin',
  'Europe/Bratislava': 'Bratislava',
  'Europe/Brussels': 'Brussels',
  'Europe/Budapest': 'Budapest',
  'Europe/Copenhagen': 'Copenhagen',
  'Europe/Ljubljana': 'Ljubljana',
  'Europe/Madrid': 'Madrid',
  'Europe/Paris': 'Paris',
  'Europe/Prague': 'Prague',
  'Europe/Rome': 'Rome',
  'Europe/Sarajevo': 'Sarajevo',
  'Europe/Skopje': 'Skopje',
  'Europe/Stockholm': 'Stockholm',
  'Europe/Vienna': 'Vienna',
  'Europe/Warsaw': 'Warsaw',
  'Africa/Lagos': 'West Central Africa',
  'Europe/Zagreb': 'Zagreb',
  'Europe/Zurich': 'Zurich',
  'Europe/Athens': 'Athens',
  'Europe/Bucharest': 'Bucharest',
  'Africa/Cairo': 'Cairo',
  'Africa/Harare': 'Harare',
  'Europe/Helsinki': 'Helsinki',
  'Asia/Jerusalem': 'Jerusalem',
  'Europe/Kaliningrad': 'Kaliningrad',
  'Europe/Kiev': 'Kyiv',
  'Africa/Johannesburg': 'Pretoria',
  'Europe/Riga': 'Riga',
  'Europe/Sofia': 'Sofia',
  'Europe/Tallinn': 'Tallinn',
  'Europe/Vilnius': 'Vilnius',
  'Asia/Baghdad': 'Baghdad',
  'Europe/Istanbul': 'Istanbul',
  'Asia/Kuwait': 'Kuwait',
  'Europe/Minsk': 'Minsk',
  'Europe/Moscow': 'Moscow',
  'Africa/Nairobi': 'Nairobi',
  'Asia/Riyadh': 'Riyadh',
  'Europe/Volgograd': 'Volgograd',
  'Asia/Tehran': 'Tehran',
  'Asia/Dubai': 'Abu Dhabi',
  'Asia/Baku': 'Baku',
  'Asia/Muscat': 'Muscat',
  'Europe/Samara': 'Samara',
  'Asia/Tbilisi': 'Tbilisi',
  'Asia/Yerevan': 'Yerevan',
  'Asia/Kabul': 'Kabul',
  'Asia/Almaty': 'Almaty',
  'Asia/Yekaterinburg': 'Ekaterinburg',
  'Asia/Karachi': 'Karachi',
  'Asia/Tashkent': 'Tashkent',
  'Asia/Kolkata': 'Chennai',
  'Asia/Calcutta': 'Chennai',
  'Asia/Colombo': 'Sri Jayawardenepura',
  'Asia/Kathmandu': 'Kathmandu',
  'Asia/Dhaka': 'Dhaka',
  'Asia/Urumqi': 'Urumqi',
  'Asia/Rangoon': 'Rangoon',
  'Asia/Bangkok': 'Bangkok',
  'Asia/Jakarta': 'Jakarta',
  'Asia/Krasnoyarsk': 'Krasnoyarsk',
  'Asia/Novosibirsk': 'Novosibirsk',
  'Asia/Shanghai': 'Beijing',
  'Asia/Chongqing': 'Chongqing',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Irkutsk': 'Irkutsk',
  'Asia/Kuala_Lumpur': 'Kuala Lumpur',
  'Australia/Perth': 'Perth',
  'Asia/Singapore': 'Singapore',
  'Asia/Taipei': 'Taipei',
  'Asia/Ulaanbaatar': 'Ulaanbaatar',
  'Asia/Tokyo': 'Tokyo',
  'Asia/Seoul': 'Seoul',
  'Asia/Yakutsk': 'Yakutsk',
  'Australia/Adelaide': 'Adelaide',
  'Australia/Darwin': 'Darwin',
  'Australia/Brisbane': 'Brisbane',
  'Australia/Sydney': 'Sydney',
  'Pacific/Guam': 'Guam',
  'Australia/Hobart': 'Hobart',
  'Australia/Melbourne': 'Melbourne',
  'Pacific/Port_Moresby': 'Port Moresby',
  'Asia/Vladivostok': 'Vladivostok',
  'Asia/Magadan': 'Magadan',
  'Pacific/Noumea': 'New Caledonia',
  'Pacific/Guadalcanal': 'Solomon Is.',
  'Asia/Srednekolymsk': 'Srednekolymsk',
  'Pacific/Auckland': 'Auckland',
  'Pacific/Fiji': 'Fiji',
  'Asia/Kamchatka': 'Kamchatka',
  'Pacific/Majuro': 'Marshall Is.',
  'Pacific/Chatham': 'Chatham Is.',
  'Pacific/Tongatapu': "Nuku'alofa",
  'Pacific/Apia': 'Samoa',
  'Pacific/Fakaofo': 'Tokelau Is.',
  // common aliases
  'America/Anchorage': 'Alaska',
  'America/Toronto': 'Eastern Time (US & Canada)',
  'America/Vancouver': 'Pacific Time (US & Canada)',
  'GMT': 'UTC',
};

function mapTimezone(snTz) {
  if (!snTz) return undefined;
  return TIMEZONE_MAP[snTz] ?? undefined;
}

const VALID_LANGUAGES = ['en', 'fr', 'de', 'es', 'pt', 'nl', 'it', 'ja', 'zh'];

function sanitizePhone(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  const cleaned = raw.startsWith('+')
    ? '+' + raw.slice(1).replace(/\D/g, '')
    : raw.replace(/\D/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function val(field) {
  return typeof field === 'object'
    ? field?.value ?? field?.display_value
    : field;
}

function displayVal(field) {
  return typeof field === 'object'
    ? field?.display_value ?? field?.value
    : field;
}

export function mapRequester(snow, deptIdMap) {
  const email = val(snow.email);
  if (!isValidEmail(email)) return null;

  const mapped = {
    first_name: val(snow.first_name) || 'Unknown',
    last_name:  val(snow.last_name)  || 'User',
    primary_email: email,
  };

  const jobTitle = val(snow.title) ?? val(snow.job_title);
  if (jobTitle) mapped.job_title = jobTitle.slice(0, 255);

  const fsTz = mapTimezone(val(snow.time_zone));
  if (fsTz) mapped.time_zone = fsTz;

  const lang = val(snow.language)?.toLowerCase()?.slice(0, 2);
  if (lang && VALID_LANGUAGES.includes(lang)) mapped.language = lang;

  mapped.vip_user = snow.vip === 'true' || snow.vip === true;

  const workPhone = sanitizePhone(val(snow.phone));
  if (workPhone) mapped.work_phone_number = workPhone;

  const mobilePhone = sanitizePhone(val(snow.mobile_phone));
  if (mobilePhone) mapped.mobile_phone_number = mobilePhone;

  const deptId = deptIdMap?.get(val(snow.department));
  if (deptId) mapped.department_id = deptId;

  return mapped;
}

export function mapAgent(snow) {
  const mapped = {
    first_name: val(snow.first_name) || 'Unknown',
    last_name: val(snow.last_name) || 'User',
    email: val(snow.email) || null,
    roles: [{ role_id: 1, assignment_scope: 'entire_helpdesk' }],
  };

  const phone = val(snow.phone);
  if (phone) mapped.work_phone_number = phone;

  return mapped;
}
