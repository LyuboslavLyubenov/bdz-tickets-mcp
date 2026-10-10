import { bdzFetch } from "./client.ts";

// ---- nomenclatures -------------------------------------------------------

export type Station = { id: number; name: string; abbr: string; uic: string };
export type SeatType = { id: number; name: string; option_group: string };
export type TravelClass = { id: number; name: string };
export type DiscountCardType = { id: number; name: string; abbr: string | null; price: number };
export type Addon = { id: number; abbr: string; name: string; price: number };

export type Nomenclatures = {
  stations: Station[];
  seats: SeatType[];
  classes: TravelClass[];
  discountCardTypes: DiscountCardType[];
  addons: Addon[];
  paramEur?: unknown;
};

export const getNomenclatures = (): Promise<Nomenclatures> =>
  bdzFetch("api/Nomenclatures/GetNomenclatures");

// ---- route search --------------------------------------------------------

export type SearchLeg = {
  date: string; // YYYY-MM-DD
  date_returning: string | null; // YYYY-MM-DD | null
  station_from: number;
  station_to: number;
};

export type TrainInfo = {
  first_class: boolean;
  second_class: boolean;
  berth: boolean;
  calendar: boolean;
  sell_seats: boolean;
};

export type TrainLeg = {
  id: number; // train_id
  name: string; // e.g. "БВ 8611"
  stations: string; // e.g. "СОФИЯ - ПЛОВДИВ"
  depart: string;
  depart_date: string;
  arrive: string;
  arrive_date: string;
  distance: string;
  total_time: string;
  time_to_wait: string;
  full: boolean;
  is_delayed: boolean;
  information: TrainInfo;
};

export type RouteOption = {
  id: number; // route_id — fresh per search, do not persist
  departure_time: string;
  departure_date: string;
  arrival_time: string;
  arrival_date: string;
  total_distance: number;
  total_time: string;
  is_visible: boolean;
  trains: TrainLeg[];
};

export type SearchDateGroup = { date: string; name: string; options: RouteOption[] };

export const searchTrains = (legs: SearchLeg[]): Promise<SearchDateGroup[]> =>
  bdzFetch("api/POSRoute/Trains", { json: legs });

// ---- seat map ------------------------------------------------------------

export type Seat = { seatId: number; seatNumber: number; seatState: number; genderId: number | null };
export type Coach = { typeId: number; seats: Seat[] };

export type SeatMapRequest = {
  date: string; // YYYY-MM-DD
  name: string; // "FROM - TO" as returned by search (train.stations)
  route: number; // route_id
  train: number; // train_id
  people: { gender: string; id: number; name: string; type: number; seatTypeId: number }[];
};

export const getSeatMap = (req: SeatMapRequest): Promise<Record<string, Coach>> =>
  bdzFetch("api/schema/info", { json: req });

// ---- ticket price / creation ---------------------------------------------

export const quotePrice = (ticket: Record<string, unknown>): Promise<number> =>
  bdzFetch("api/Ticket/GetTicket?onlyPrice=true", { json: ticket });

export type TicketPreview = {
  totalPrice: number;
  ticketIDs: number[];
  passengersTickets: {
    passengerId: number;
    passengerNames: string;
    tariffFullText: string;
    tariffShortText: string;
    seats: string[];
    addons: unknown[];
    ticketPrice: number;
  }[];
};

export const createTicket = (ticket: Record<string, unknown>): Promise<TicketPreview> =>
  bdzFetch("api/Ticket/GetTicket?onlyPrice=false", { json: ticket });

// ---- payment handoff -------------------------------------------------------

export type PaymentTransaction = { transactionID: number; description?: string };

/** NOTE: the literal `?&totalPrice=` prefix matches the site's own request. */
export const createPaymentTransaction = (
  totalPrice: number,
  ticketIDs: number[],
): Promise<PaymentTransaction> =>
  bdzFetch(`api/Ticket/GetTicketPaymentTransaction?&totalPrice=${totalPrice}`, { json: ticketIDs });

export type GatewayResponse =
  | { status: 301; url: string }
  | { url: string; formFields: Record<string, string> };

/** The site concatenates "api/Payment/Get" + "BoricaRequest" — no slash between them. */
export const gatewayRequest = (
  provider: "Borica" | "Epay",
  transactionId: number,
): Promise<GatewayResponse> =>
  bdzFetch(`api/Payment/Get${provider}Request?transactionId=${transactionId}`);

export const checkPayment = (transactionId: number): Promise<unknown> =>
  bdzFetch(`api/Payment/CheckPayment?transactionId=${transactionId}`);

// ---- ticket library --------------------------------------------------------

export type UserTicket = {
  id: number;
  uId: string;
  route: string;
  status: string;
  statusID: number; // 2 = issued, 6 = cancelled, 11 = pending
  price: number;
  departureDate: string;
  returnDate: string | null;
  createDate: string;
  transactionID: number;
  passenger: string;
  canReturnByPOS: boolean;
  [key: string]: unknown;
};

export type TicketPage = { tickets: UserTicket[]; totalPages: number };

export const getUserTickets = (pageNum = 1): Promise<TicketPage> =>
  bdzFetch(`api/Ticket/GetUserTickets?pageNum=${pageNum}`, { json: {} });

export const getOldUserTickets = (pageNum = 1): Promise<TicketPage> =>
  bdzFetch(`api/Ticket/GetOldUserTickets?pageNum=${pageNum}`, { json: {} });

export const getTicketPdf = (
  ticketId: number,
): Promise<{ fileName: string; pdf: string }> =>
  bdzFetch(`api/ticket/GetTicketPdf?ticketId=${ticketId}`);
