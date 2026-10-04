import {LIFE_RULES, BUILDING_RULES} from '../../region/model/life/rules';
import type {RegionalEconomy} from '../../region/model/life/types';
import type {CityTraffic} from '../trafficFlow';
import type {LanePose, LaneRoute} from '../trafficRoutes';
import {sampleLaneRoute} from '../trafficRoutes';
import type {AuthoredWorldDefinition} from './definition';
import {NoNativeRoute} from './regionRouting';
import type {RegionRouting} from './regionRouting';
import type {Population} from './population';
import type {Business, HousingUnit, ParkingFacility, RoadAccess} from './types';
import {z} from 'zod';
import type {HarborSupplyProvider, HarborShipment} from '../harbor';

export type NativeAccount =
  | {kind: 'treasury'}
  | {kind: 'family'; id: number}
  | {kind: 'investor'; id: string};
export interface NativeInvestor {
  id: string;
  cash: number;
}
export interface NativeGoodsRules {
  productionWorkerSeconds: number;
  productionUnitCost: number;
  importPrice: number;
  wholesalePrice: number;
  warehousePrice: number;
  retailPrice: number;
  deliveryFee: number;
  deliverySize: number;
  loadingSeconds: number;
  unloadingSeconds: number;
  taxRate: number;
  maxTrucks: number;
}
export interface NativeBuildingEconomy {
  buildingId: string;
  role: 'factory' | 'shop' | 'warehouse' | 'service';
  inventoryCapacity: number;
  owner: NativeAccount;
  workingCapital: number;
}
export interface NativeEconomyDefinition {
  readonly investors?: readonly NativeInvestor[];
  readonly buildings?: readonly NativeBuildingEconomy[];
  readonly rules?: Partial<NativeGoodsRules>;
  readonly externalGoods?: number;
  readonly automaticOrders?: boolean;
}
export interface NativeGoodsLedger extends RegionalEconomy {
  exportsReceived: number;
  familyCapitalReceived: number;
}
export interface NativeDelivery {
  id: string;
  sourceId: string;
  targetId: string;
  quantity: number;
  cargo: number;
  escrow: number;
  unitPrice: number;
  vehicleId: number;
  state: 'loading' | 'in-transit' | 'unloading' | 'delivered';
  phaseStarted: number;
  route: LaneRoute;
}
export interface NativeGoodsSave {
  version: 1;
  lastSeconds: number;
  nextId: number;
  taxRate?: number;
  investors: NativeInvestor[];
  owners: Array<[string, NativeAccount]>;
  work: Array<[string, number]>;
  services: Array<[string, number]>;
  capital: Array<{buildingId: string; value: number}>;
  deliveries: NativeDelivery[];
  completedDeliveries: number;
  ledger: NativeGoodsLedger;
}
export interface NativeGoodsShipment {
  id: string;
  quantity: number;
  unitPrice: number;
  warehouse: number;
}
export interface NativeHarborSupply {
  imports(visit: number, warehouse: number): NativeGoodsShipment[];
  takeExport(warehouse: number): NativeGoodsShipment | null;
  receive(shipment: NativeGoodsShipment, warehouse: number): boolean;
  exported(shipments: readonly NativeGoodsShipment[]): boolean;
}

const accountSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('treasury')}),
  z.object({kind: z.literal('family'), id: z.number().int().nonnegative()}),
  z.object({kind: z.literal('investor'), id: z.string().min(1)}),
]);
const nonnegative = z.number().int().nonnegative();
const money = z.number().nonnegative().finite();
const ledgerSchema = z.object({
  initialMoney: z.number().finite(),
  initialGoods: nonnegative,
  externalMoney: z.number().finite(),
  externalGoods: nonnegative,
  produced: nonnegative,
  consumed: nonnegative,
  taxesPaid: money,
  maintenancePaid: money,
  maintenanceDebt: money,
  constructionPaid: money,
  wagesPaid: money,
  salesValue: money,
  importsPaid: money,
  exportsReceived: money,
  familyCapitalReceived: money,
});
const goodsSchema = z.object({
  version: z.literal(1),
  lastSeconds: z.number().nonnegative().finite(),
  nextId: nonnegative,
  taxRate: z.number().min(0).max(1).optional(),
  investors: z.array(z.object({id: z.string().min(1), cash: money})),
  owners: z.array(z.tuple([z.string(), accountSchema])),
  work: z.array(z.tuple([z.string(), z.number().nonnegative().finite()])),
  services: z
    .array(z.tuple([z.string(), z.number().nonnegative().finite()]))
    .optional(),
  capital: z.array(z.object({buildingId: z.string(), value: money})),
  completedDeliveries: nonnegative,
  ledger: ledgerSchema,
  deliveries: z.array(
    z.custom<NativeDelivery>((value: unknown) => {
      if (!isRecord(value)) {
        return false;
      }

      return z
        .object({
          id: z.string(),
          sourceId: z.string(),
          targetId: z.string(),
          quantity: nonnegative,
          cargo: nonnegative,
          escrow: money,
          unitPrice: money,
          vehicleId: nonnegative,
          state: z.enum(['loading', 'in-transit', 'unloading', 'delivered']),
          phaseStarted: z.number().nonnegative().finite(),
          route: z.object({
            length: z.number().positive().finite(),
            segments: z.array(z.record(z.string(), z.unknown())).min(1),
          }),
        })
        .safeParse(value).success;
    }),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Economic custody uses native accounts/stock and native physical traffic only. */
export class NativeGoodsEconomy {
  readonly ledger: NativeGoodsLedger;
  readonly investors: NativeInvestor[];
  readonly deliveries: NativeDelivery[] = [];
  private readonly owners = new Map<string, NativeAccount>();
  private readonly configurations = new Map<string, NativeBuildingEconomy>();
  private readonly businesses = new Map<string, Business>();
  private readonly work = new Map<string, number>();
  private readonly services = new Map<string, number>();
  private readonly serviceEntries = new Map<string, string | null>();
  private readonly capital: Array<{buildingId: string; value: number}> = [];
  private definition: AuthoredWorldDefinition;
  private lastSeconds = 0;
  private nextId = 1;
  private completedDeliveries = 0;
  private portCargo: () => Array<{
    quantity: number;
    buildingId: string;
    flow?: 'import' | 'export';
  }> = () => [];
  rules: NativeGoodsRules;

  constructor(
    readonly population: Population,
    readonly traffic: CityTraffic,
    readonly routing: RegionRouting,
    definition: AuthoredWorldDefinition,
  ) {
    this.definition = definition;
    this.rules = z
      .object({
        productionWorkerSeconds: z.number().positive().finite(),
        productionUnitCost: z.number().int().positive(),
        importPrice: z.number().int().positive(),
        wholesalePrice: z.number().int().positive(),
        warehousePrice: z.number().int().positive(),
        retailPrice: z.number().int().positive(),
        deliveryFee: nonnegative,
        deliverySize: z.number().int().positive(),
        loadingSeconds: z.number().positive().finite(),
        unloadingSeconds: z.number().positive().finite(),
        taxRate: z.number().min(0).max(1),
        maxTrucks: z.number().int().positive(),
      })
      .parse({
        ...LIFE_RULES,
        productionWorkerSeconds: 360,
        importPrice: 40,
        wholesalePrice: 60,
        warehousePrice: 80,
        retailPrice: 160,
        deliverySize: 64,
        ...definition.economy?.rules,
      });
    const migration = definition.metadata?.['legacyMigration'];
    const legacy = isRecord(migration) ? migration : {};
    const investorInput =
      definition.economy?.investors ?? legacy['investors'] ?? [];

    this.investors = z
      .array(z.object({id: z.string().min(1), cash: money}))
      .parse(investorInput);
    const externalGoods =
      definition.economy?.externalGoods ?? LIFE_RULES.externalGoods;
    const base: NativeGoodsLedger = {
      initialMoney: 0,
      initialGoods: 0,
      externalMoney: 0,
      externalGoods,
      produced: 0,
      consumed: 0,
      taxesPaid: 0,
      maintenancePaid: 0,
      maintenanceDebt: 0,
      constructionPaid: 0,
      wagesPaid: 0,
      salesValue: 0,
      importsPaid: 0,
      exportsReceived: 0,
      familyCapitalReceived: 0,
    };

    this.ledger = isRecord(legacy['ledger'])
      ? ledgerSchema.parse({...base, ...legacy['ledger']})
      : base;
    this.updateDefinition(definition);

    if (Array.isArray(legacy['buildingHistory'])) {
      for (const item of legacy['buildingHistory']) {
        if (!isRecord(item) || typeof item['id'] !== 'string') {
          continue;
        }
        if (typeof item['productionWork'] === 'number') {
          this.work.set(item['id'], item['productionWork']);
        }

        const ownerId = item['ownerId'];

        if (
          typeof ownerId === 'string' &&
          this.investors.some(investor => investor.id === ownerId)
        ) {
          this.owners.set(item['id'], {kind: 'investor', id: ownerId});
        }

        const identities = legacy['identities'];
        const families = isRecord(identities) ? identities['families'] : null;

        if (Array.isArray(families)) {
          const values: unknown[] = families;
          const owner = values.find(
            value => isRecord(value) && value['externalId'] === ownerId,
          );

          if (isRecord(owner) && typeof owner['nativeId'] === 'number') {
            this.owners.set(item['id'], {
              kind: 'family',
              id: owner['nativeId'],
            });
          }
        }
      }
    }

    this.completedDeliveries =
      typeof legacy['completedDeliveries'] === 'number'
        ? legacy['completedDeliveries']
        : 0;

    if (!isRecord(legacy['ledger'])) {
      this.ledger.initialMoney = this.moneyBalance();
      this.ledger.initialGoods = this.goodsBalance();
    }
  }

  updateDefinition(definition: AuthoredWorldDefinition): void {
    this.definition = definition;
    this.configurations.clear();
    this.serviceEntries.clear();
    this.businesses.clear();

    for (const business of this.population.businesses) {
      this.businesses.set(business.building, business);
    }

    for (const item of definition.economy?.buildings ?? []) {
      if (!this.owners.has(item.buildingId)) {
        this.owners.set(item.buildingId, item.owner);
      }
    }
  }

  setPortCargoProvider(
    provider: () => Array<{
      quantity: number;
      buildingId: string;
      flow?: 'import' | 'export';
    }>,
  ): void {
    this.portCargo = provider;
  }

  registriesChanged(): void {
    this.updateDefinition(this.definition);
  }

  private configuration(id: string): NativeBuildingEconomy {
    const cached = this.configurations.get(id);

    if (cached) {
      return cached;
    }

    const configured = this.definition.economy?.buildings?.find(
      item => item.buildingId === id,
    );

    if (configured) {
      return configured;
    }

    const place = this.population.profile.places.find(place => place.id === id);
    const kind =
      place?.kind ??
      this.definition.placements.find(placement => placement.id === id)?.kind ??
      'park';
    const metadata = this.definition.metadata;
    const migration = metadata?.['legacyMigration'];
    const history: unknown =
      isRecord(migration) && Array.isArray(migration['buildingHistory'])
        ? migration['buildingHistory'].find(
            item => isRecord(item) && item['id'] === id,
          )
        : null;
    const document = metadata?.['regionDocument'];
    const warehouse =
      this.definition.infrastructure?.ports.some(port =>
        port.warehouseBuildingIds.includes(id),
      ) ||
      (isRecord(history) && history['kind'] === 'warehouse') ||
      (isRecord(document) &&
        Array.isArray(document['warehouses']) &&
        document['warehouses'].some(
          item => isRecord(item) && item['id'] === id,
        ));
    const role = warehouse
      ? 'warehouse'
      : kind === 'factory'
        ? 'factory'
        : kind === 'shop'
          ? 'shop'
          : 'service';
    const rules =
      role === 'warehouse'
        ? BUILDING_RULES.warehouse
        : role === 'factory'
          ? BUILDING_RULES.industrial
          : BUILDING_RULES.commercial;
    const compiled: NativeBuildingEconomy = {
      buildingId: id,
      role,
      inventoryCapacity:
        isRecord(history) && typeof history['inventoryCapacity'] === 'number'
          ? history['inventoryCapacity']
          : rules.inventoryCapacity,
      workingCapital:
        role === 'warehouse' ||
        kind === 'home' ||
        kind === 'park' ||
        kind === 'station'
          ? 0
          : rules.workingCapital,
      owner: this.owners.get(id) ?? {kind: 'treasury'},
    };

    this.configurations.set(id, compiled);

    return compiled;
  }

  private business(id: string): Business | undefined {
    return this.businesses.get(id);
  }

  private accountBalance(account: NativeAccount): number {
    if (account.kind === 'treasury') {
      return this.population.treasury;
    }
    if (account.kind === 'family') {
      return this.population.families[account.id]?.balance ?? 0;
    }

    return (
      this.investors.find(investor => investor.id === account.id)?.cash ?? 0
    );
  }

  private credit(account: NativeAccount, value: number): void {
    if (account.kind === 'treasury') {
      this.population.treasury += value;

      return;
    }
    if (account.kind === 'family') {
      const family = this.population.families[account.id];

      if (!family) {
        throw new Error('Неизвестный семейный счёт');
      }

      family.balance += value;

      return;
    }

    const investor = this.investors.find(
      investor => investor.id === account.id,
    );

    if (!investor) {
      throw new Error('Неизвестный счёт инвестора');
    }

    investor.cash += value;
  }

  payRent(unit: HousingUnit, value: number): void {
    this.credit(
      unit.owner === null
        ? (this.owners.get(unit.building) ?? {kind: 'treasury'})
        : {kind: 'family', id: unit.owner},
      value,
    );
  }

  payHome(unit: HousingUnit, value: number): void {
    this.credit(this.owners.get(unit.building) ?? {kind: 'treasury'}, value);
  }

  syncHiringCapacity(): void {
    const shops = this.population.profile.places.filter(
      place => place.kind === 'shop',
    );
    const customers = new Map<string, number>();

    for (const family of this.population.families) {
      if (!family.arrived) {
        continue;
      }

      const home = this.population.home(family);
      const shop = [...shops].sort(
        (a, b) =>
          Math.hypot(home.door.x - a.door.x, home.door.z - a.door.z) -
          Math.hypot(home.door.x - b.door.x, home.door.z - b.door.z),
      )[0];

      if (shop) {
        customers.set(
          shop.id,
          (customers.get(shop.id) ?? 0) + family.members.length * 2,
        );
      }
    }

    for (const business of this.population.businesses) {
      const place = this.population.profile.places.find(
        place => place.id === business.building,
      );

      if (!place || place.wage <= 0) {
        continue;
      }

      const funded = Math.floor(this.balance(business.building) / place.wage);
      const demand =
        place.kind === 'shop'
          ? Math.max(
              1,
              Math.floor(
                ((customers.get(place.id) ?? 0) *
                  Math.max(
                    0,
                    this.rules.retailPrice -
                      this.rules.warehousePrice -
                      this.rules.retailPrice * this.rules.taxRate,
                  )) /
                  place.wage,
              ),
            )
          : place.capacity;

      business.jobs = Math.max(
        business.workers.length,
        Math.min(place.capacity, funded, demand),
      );
    }
  }

  recordWage(value: number): void {
    this.ledger.wagesPaid += value;
  }

  recordConsumption(quantity: number): void {
    this.ledger.consumed += quantity;
  }

  recordRetail(id: string, value: number): void {
    const business = this.business(id);

    if (!business) {
      throw new Error('Нет счёта продавца');
    }

    const role = this.configuration(id).role;
    const tax =
      ['factory', 'shop'].includes(role) ||
      this.population.profile.places.find(place => place.id === id)?.kind ===
        'cafe'
        ? Math.floor(value * this.rules.taxRate)
        : 0;

    business.balance -= tax;
    this.population.treasury += tax;
    this.ledger.taxesPaid += tax;
    this.ledger.salesValue += value;
  }

  get retailPrice(): number {
    return this.rules.retailPrice;
  }

  recordFamilyCapital(value: number, goods = 0): number {
    this.ledger.externalMoney -= value;
    this.ledger.familyCapitalReceived += value;
    const transferred = Math.min(this.ledger.externalGoods, goods);

    this.ledger.externalGoods -= transferred;

    return transferred;
  }

  recordConstruction(
    definition: AuthoredWorldDefinition,
    newIds: readonly string[],
    cost: number,
  ): void {
    this.updateDefinition(definition);
    let remaining = cost;

    for (const id of newIds) {
      const workingCapital = this.configuration(id).workingCapital;
      const amount = Math.min(remaining, workingCapital);

      if (amount > 0) {
        this.capital.push({buildingId: id, value: amount});
        remaining -= amount;
      }
    }

    this.ledger.externalMoney += remaining;
    this.ledger.constructionPaid += remaining;
    this.updateDefinition(definition);
    this.releaseCapital();
  }

  private releaseCapital(): void {
    for (let index = this.capital.length - 1; index >= 0; index--) {
      const escrow = this.capital[index]!;
      const business = this.business(escrow.buildingId);

      if (!business) {
        if (
          !this.definition.placements.some(
            placement => placement.id === escrow.buildingId,
          )
        ) {
          this.population.treasury += escrow.value;
          this.capital.splice(index, 1);
        }

        continue;
      }

      business.balance += escrow.value;
      this.capital.splice(index, 1);
    }
  }

  fundBusiness(id: string, account: NativeAccount, value: number): boolean {
    const business = this.business(id);

    if (
      !business ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      this.accountBalance(account) < value
    ) {
      return false;
    }

    this.credit(account, -value);
    business.balance += value;

    return true;
  }

  private balance(id: string): number {
    return this.configuration(id).role === 'warehouse' &&
      this.configuration(id).owner.kind === 'treasury'
      ? this.population.treasury
      : (this.business(id)?.balance ?? 0);
  }

  private debit(id: string, value: number): boolean {
    if (this.balance(id) < value) {
      return false;
    }
    if (
      this.configuration(id).role === 'warehouse' &&
      this.configuration(id).owner.kind === 'treasury'
    ) {
      this.population.treasury -= value;
    } else {
      const business = this.business(id);

      if (!business) {
        return false;
      }

      business.balance -= value;
    }

    return true;
  }

  private creditBusiness(id: string, value: number): void {
    if (
      this.configuration(id).role === 'warehouse' &&
      this.configuration(id).owner.kind === 'treasury'
    ) {
      this.population.treasury += value;
    } else {
      const business = this.business(id);

      if (!business) {
        throw new Error('Нет счёта предприятия');
      }

      business.balance += value;
    }
  }

  private pending(id: string): number {
    return (
      this.deliveries
        .filter(
          delivery =>
            delivery.targetId === id && delivery.state !== 'delivered',
        )
        .reduce((sum, delivery) => sum + delivery.quantity, 0) +
      this.portCargo()
        .filter(cargo => cargo.buildingId === id && cargo.flow !== 'export')
        .reduce((sum, cargo) => sum + cargo.quantity, 0)
    );
  }

  availableStock(id: string): number {
    return Math.max(
      0,
      (this.business(id)?.stock ?? 0) -
        this.deliveries
          .filter(
            delivery =>
              delivery.sourceId === id &&
              delivery.state === 'loading' &&
              delivery.cargo === 0,
          )
          .reduce((sum, delivery) => sum + delivery.quantity, 0),
    );
  }

  private access(id: string, departure: boolean): RoadAccess | null {
    const entry = this.definition.entries.find(entry => entry.id === id);

    if (entry) {
      return departure ? entry.access : entry.exit;
    }

    const place = this.population.profile.places.find(place => place.id === id);
    const facility: ParkingFacility | undefined =
      place?.parking === null || place?.parking === undefined
        ? undefined
        : this.population.profile.facilities[place.parking];

    return facility?.road ?? null;
  }

  requestDelivery(
    sourceId: string,
    targetId: string,
    requested = this.rules.deliverySize,
  ): boolean {
    const sourceEntry = this.definition.entries.some(
      entry => entry.id === sourceId,
    );
    const targetEntry = this.definition.entries.some(
      entry => entry.id === targetId,
    );
    const source = this.business(sourceId);
    const target = this.business(targetId);

    if (
      sourceId === targetId ||
      (!source && !sourceEntry) ||
      (!target && !targetEntry) ||
      !Number.isSafeInteger(requested) ||
      requested <= 0 ||
      this.deliveries.filter(delivery => delivery.state !== 'delivered')
        .length >= this.rules.maxTrucks
    ) {
      return false;
    }

    const from = this.access(sourceId, true);
    const to = this.access(targetId, false);

    if (!from || !to) {
      return false;
    }

    let route;

    try {
      route = this.routing.drive(from, to);
    } catch (error) {
      if (error instanceof NoNativeRoute) {
        return false;
      }

      throw error;
    }

    const unitPrice = sourceEntry
      ? this.rules.importPrice
      : this.configuration(sourceId).role === 'warehouse'
        ? this.rules.warehousePrice
        : this.rules.wholesalePrice;
    const free = targetEntry
      ? requested
      : Math.max(
          0,
          this.configuration(targetId).inventoryCapacity -
            target!.stock -
            this.pending(targetId),
        );
    const quantity = Math.min(
      requested,
      free,
      sourceEntry ? this.ledger.externalGoods : this.availableStock(sourceId),
      targetEntry
        ? requested
        : Math.floor(
            Math.max(0, this.balance(targetId) - this.rules.deliveryFee) /
              unitPrice,
          ),
    );

    if (quantity <= 0) {
      return false;
    }

    const escrow = targetEntry
      ? 0
      : quantity * unitPrice + this.rules.deliveryFee;

    if (escrow && !this.debit(targetId, escrow)) {
      return false;
    }

    const vehicleId = this.traffic.addCar(
      {length: 5.8, width: 1.9},
      sampleLaneRoute(route, 0),
    );

    try {
      this.traffic.registerPlan(vehicleId, {
        route,
        stops: [0, route.length],
        initialStop: 0,
      });
    } catch (error) {
      this.traffic.discardDormantVehicle(vehicleId);

      if (escrow) {
        this.creditBusiness(targetId, escrow);
      }
      if (error instanceof Error && /occupied/.test(error.message)) {
        return false;
      }

      throw error;
    }

    this.deliveries.push({
      id: `native-delivery-${this.nextId++}`,
      sourceId,
      targetId,
      quantity,
      cargo: 0,
      escrow,
      unitPrice,
      vehicleId,
      state: 'loading',
      phaseStarted: this.lastSeconds,
      route,
    });

    return true;
  }

  harborProvider(warehouses: readonly string[]): HarborSupplyProvider {
    const target = (warehouse: 0 | 1): Business | undefined =>
      this.business(warehouses[warehouse] ?? '');
    const imports = (_visit: number, warehouse: 0 | 1): HarborShipment[] => {
      const business = target(warehouse);

      if (!business) {
        return [];
      }

      let free = Math.max(
        0,
        this.configuration(business.building).inventoryCapacity -
          business.stock -
          this.pending(business.building),
      );
      const shipments: HarborShipment[] = [];

      for (let bay = 0; bay < 3; bay++) {
        const quantity = Math.min(
          this.rules.deliverySize,
          free,
          this.ledger.externalGoods,
          Math.floor(this.balance(business.building) / this.rules.importPrice),
        );

        if (
          quantity <= 0 ||
          !this.debit(business.building, quantity * this.rules.importPrice)
        ) {
          break;
        }

        this.ledger.externalMoney += quantity * this.rules.importPrice;
        this.ledger.importsPaid += quantity * this.rules.importPrice;
        this.ledger.externalGoods -= quantity;
        free -= quantity;
        shipments.push({
          id: `native-shipment-${this.nextId++}`,
          warehouse,
          quantity,
          unitPrice: this.rules.importPrice,
        });
      }

      return shipments;
    };

    return {
      nextVisit: after => {
        for (let offset = 1; offset <= 4; offset++) {
          const visit = after + offset;
          const warehouse = [0, 1, 1, 0][visit % 4]!;
          const id = warehouses[warehouse]!;
          const business = this.business(id);

          if (!business) {
            continue;
          }
          if (
            visit % 2 === 0 &&
            this.ledger.externalGoods > 0 &&
            this.balance(id) >= this.rules.importPrice &&
            business.stock + this.pending(id) <
              this.configuration(id).inventoryCapacity
          ) {
            return visit;
          }
          if (
            visit % 2 !== 0 &&
            (this.availableStock(id) > 0 ||
              this.portCargo().some(
                cargo => cargo.buildingId === id && cargo.flow === 'export',
              ))
          ) {
            return visit;
          }
        }

        return null;
      },
      exportTarget: warehouse =>
        Math.min(
          3,
          this.portCargo().filter(
            cargo =>
              cargo.buildingId === warehouses[warehouse] &&
              cargo.flow === 'export',
          ).length +
            Math.ceil(
              this.availableStock(warehouses[warehouse]!) /
                this.rules.deliverySize,
            ),
        ),
      imports,
      takeExport: warehouse => {
        const business = target(warehouse);

        if (!business) {
          return null;
        }

        const quantity = Math.min(
          this.rules.deliverySize,
          this.availableStock(business.building),
        );

        if (quantity <= 0) {
          return null;
        }

        business.stock -= quantity;

        return {
          id: `native-shipment-${this.nextId++}`,
          warehouse,
          quantity,
          unitPrice: this.rules.wholesalePrice,
        };
      },
      receive: (shipment, warehouse) => {
        const business = target(warehouse);

        if (
          !business ||
          business.stock + shipment.quantity >
            this.configuration(business.building).inventoryCapacity
        ) {
          return false;
        }

        business.stock += shipment.quantity;

        return true;
      },
      exported: shipments => {
        for (const shipment of shipments) {
          const business = target(shipment.warehouse);

          if (!business) {
            return false;
          }
        }

        for (const shipment of shipments) {
          const business = target(shipment.warehouse)!;
          const value = shipment.quantity * shipment.unitPrice;

          this.creditBusiness(business.building, value);
          this.recordRetail(business.building, value);
          this.ledger.externalMoney -= value;
          this.ledger.externalGoods += shipment.quantity;
          this.ledger.exportsReceived += value;
        }

        return true;
      },
      idle: () =>
        warehouses.every(
          id =>
            this.availableStock(id) <= 0 &&
            (this.balance(id) < this.rules.importPrice ||
              this.configuration(id).inventoryCapacity -
                (this.business(id)?.stock ?? 0) -
                this.pending(id) <=
                0 ||
              this.ledger.externalGoods <= 0),
        ),
    };
  }

  step(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < this.lastSeconds) {
      throw new Error('Economic time must be monotonic');
    }

    const delta = seconds - this.lastSeconds;
    const orderDue =
      Math.floor(seconds / (this.definition.calendar?.secondsPerMinute ?? 3)) >
      Math.floor(
        this.lastSeconds / (this.definition.calendar?.secondsPerMinute ?? 3),
      );

    this.lastSeconds = seconds;
    const timeScale = (this.definition.calendar?.secondsPerMinute ?? 3) / 60;
    const attendance = new Map<string, number>();

    for (const person of this.population.people) {
      if (
        person.activity !== 'work' ||
        person.job?.building !== person.location
      ) {
        continue;
      }

      attendance.set(
        person.location,
        (attendance.get(person.location) ?? 0) +
          Math.max(0, Math.min(delta, seconds - person.workStarted)),
      );
    }

    for (const business of this.population.businesses) {
      const place = this.population.profile.places.find(
        place => place.id === business.building,
      );

      if (place?.kind !== 'office') {
        continue;
      }

      let entryId = this.serviceEntries.get(business.building);

      if (entryId === undefined) {
        entryId = null;

        for (const entry of this.definition.entries) {
          const terminal =
            this.population.profile.facilities[entry.terminalFacilityId];

          if (!terminal) {
            continue;
          }

          try {
            this.routing.walk(place.access, terminal.access);
            entryId = entry.id;
            break;
          } catch (error) {
            if (!(error instanceof NoNativeRoute)) {
              throw error;
            }
          }
        }

        this.serviceEntries.set(business.building, entryId);
      }
      if (entryId === null) {
        continue;
      }

      const earned =
        ((attendance.get(business.building) ?? 0) * place.wage * 1.2) /
        (480 * (this.definition.calendar?.secondsPerMinute ?? 3));
      const accumulated = (this.services.get(business.building) ?? 0) + earned;
      const value = Math.floor(accumulated + 1e-8);

      this.services.set(business.building, accumulated - value);

      if (value > 0) {
        business.balance += value;
        this.ledger.externalMoney -= value;
        this.ledger.exportsReceived += value;
        const tax = Math.floor(value * this.rules.taxRate);

        business.balance -= tax;
        this.population.treasury += tax;
        this.ledger.taxesPaid += tax;
      }
    }

    for (const business of this.population.businesses) {
      const rule = this.configuration(business.building);

      if (
        rule.role !== 'factory' ||
        business.stock >= rule.inventoryCapacity ||
        business.balance < this.rules.productionUnitCost
      ) {
        continue;
      }

      const worked = attendance.get(business.building) ?? 0;
      let work =
        Math.round(((this.work.get(business.building) ?? 0) + worked) * 1e8) /
        1e8;
      const threshold = this.rules.productionWorkerSeconds * timeScale;

      while (
        work >= threshold &&
        business.stock < rule.inventoryCapacity &&
        business.balance >= this.rules.productionUnitCost
      ) {
        work -= threshold;
        business.stock++;
        business.balance -= this.rules.productionUnitCost;
        this.ledger.externalMoney += this.rules.productionUnitCost;
        this.ledger.produced++;
      }

      this.work.set(business.building, Math.min(work, threshold));
    }

    for (const delivery of this.deliveries) {
      const sourceEntry = this.definition.entries.some(
        entry => entry.id === delivery.sourceId,
      );
      const targetEntry = this.definition.entries.some(
        entry => entry.id === delivery.targetId,
      );

      if (
        delivery.state === 'loading' &&
        seconds - delivery.phaseStarted >= this.rules.loadingSeconds * timeScale
      ) {
        if (delivery.cargo === 0) {
          if (sourceEntry) {
            if (this.ledger.externalGoods < delivery.quantity) {
              continue;
            }

            this.ledger.externalGoods -= delivery.quantity;
          } else {
            const source = this.business(delivery.sourceId);

            if (!source || source.stock < delivery.quantity) {
              continue;
            }

            source.stock -= delivery.quantity;
          }

          delivery.cargo = delivery.quantity;
          const value = delivery.quantity * delivery.unitPrice;

          if (!targetEntry) {
            if (sourceEntry) {
              this.ledger.externalMoney += value;
              this.ledger.importsPaid += value;
            } else {
              this.creditBusiness(delivery.sourceId, value);
              this.recordRetail(delivery.sourceId, value);
            }

            this.population.treasury += this.rules.deliveryFee;
            delivery.escrow = 0;
          }
        }

        this.traffic.release(delivery.vehicleId);
        delivery.state = 'in-transit';
        delivery.phaseStarted = seconds;
      } else if (
        delivery.state === 'in-transit' &&
        this.traffic.atStop(delivery.vehicleId) === 1
      ) {
        delivery.state = 'unloading';
        delivery.phaseStarted = seconds;
      } else if (
        delivery.state === 'unloading' &&
        seconds - delivery.phaseStarted >=
          this.rules.unloadingSeconds * timeScale
      ) {
        if (targetEntry) {
          this.ledger.externalGoods += delivery.cargo;
          const value = delivery.cargo * delivery.unitPrice;

          this.creditBusiness(delivery.sourceId, value);
          this.recordRetail(delivery.sourceId, value);
          this.ledger.externalMoney -= value;
          this.ledger.exportsReceived += value;
        } else {
          const target = this.business(delivery.targetId);

          if (
            !target ||
            target.stock + delivery.cargo >
              this.configuration(delivery.targetId).inventoryCapacity
          ) {
            continue;
          }

          target.stock += delivery.cargo;
        }

        delivery.cargo = 0;
        delivery.state = 'delivered';
        this.traffic.park(delivery.vehicleId);
        this.completedDeliveries++;
      }
    }

    if (orderDue && this.definition.economy?.automaticOrders !== false) {
      for (const target of this.population.businesses) {
        const role = this.configuration(target.building).role;

        if (
          (role !== 'shop' && role !== 'warehouse') ||
          target.stock + this.pending(target.building) >=
            Math.min(
              this.configuration(target.building).inventoryCapacity / 2,
              this.rules.deliverySize * 2,
            )
        ) {
          continue;
        }

        const suppliers = this.population.businesses.filter(
          source =>
            source.building !== target.building &&
            this.availableStock(source.building) > 0 &&
            ['factory', 'warehouse'].includes(
              this.configuration(source.building).role,
            ),
        );
        const ids = [
          ...suppliers.map(source => source.building),
          ...this.definition.entries.map(entry => entry.id),
        ];

        for (const id of ids) {
          if (this.requestDelivery(id, target.building)) {
            break;
          }
        }
      }
    }

    this.releaseCapital();

    if (orderDue) {
      this.syncHiringCapacity();
    }
  }

  freight(): LanePose[] {
    return this.deliveries
      .filter(delivery => delivery.state !== 'delivered')
      .map(delivery => this.traffic.pose(delivery.vehicleId));
  }

  rebaseExistingAccounts(): void {
    const migration = this.definition.metadata?.['legacyMigration'];

    if (isRecord(migration) && isRecord(migration['ledger'])) {
      return;
    }

    this.ledger.initialMoney = this.moneyBalance();
    this.ledger.initialGoods = this.goodsBalance();
  }

  moneyBalance(): number {
    return (
      this.population.treasury +
      this.population.families.reduce(
        (sum, family) => sum + family.balance,
        0,
      ) +
      this.population.businesses.reduce(
        (sum, business) => sum + business.balance,
        0,
      ) +
      this.investors.reduce((sum, investor) => sum + investor.cash, 0) +
      this.capital.reduce((sum, capital) => sum + capital.value, 0) +
      this.deliveries.reduce((sum, delivery) => sum + delivery.escrow, 0) +
      this.ledger.externalMoney
    );
  }

  goodsBalance(): number {
    return (
      this.population.families.reduce((sum, family) => sum + family.food, 0) +
      this.population.businesses.reduce(
        (sum, business) => sum + business.stock,
        0,
      ) +
      this.deliveries.reduce((sum, delivery) => sum + delivery.cargo, 0) +
      this.portCargo().reduce((sum, cargo) => sum + cargo.quantity, 0) +
      this.ledger.externalGoods +
      this.ledger.consumed -
      this.ledger.produced
    );
  }

  /** Player-controlled sales tax for authored worlds; the prototype keeps its original rate. */
  setTaxRate(rate: number): void {
    this.rules = {...this.rules, taxRate: z.number().min(0).max(1).parse(rate)};
  }

  warehouseCount(): number {
    let count = 0;

    for (const configuration of this.configurations.values()) {
      if (configuration.role === 'warehouse') {
        count += 1;
      }
    }

    return count;
  }

  save(): NativeGoodsSave {
    return structuredClone({
      version: 1,
      lastSeconds: this.lastSeconds,
      nextId: this.nextId,
      taxRate: this.rules.taxRate,
      investors: this.investors,
      owners: [...this.owners],
      work: [...this.work],
      services: [...this.services],
      capital: this.capital,
      deliveries: this.deliveries,
      completedDeliveries: this.completedDeliveries,
      ledger: this.ledger,
    });
  }

  restore(value: unknown): void {
    const parsed = goodsSchema.safeParse(value);

    if (!parsed.success) {
      throw new Error('Повреждённые экономические счета', {
        cause: parsed.error,
      });
    }

    const saved = parsed.data;

    this.lastSeconds = saved.lastSeconds;
    this.nextId = saved.nextId;
    this.completedDeliveries = saved.completedDeliveries;

    if (saved.taxRate !== undefined) {
      this.rules = {...this.rules, taxRate: saved.taxRate};
    }

    this.investors.splice(0, this.investors.length, ...saved.investors);
    this.deliveries.splice(0, this.deliveries.length, ...saved.deliveries);
    this.capital.splice(0, this.capital.length, ...saved.capital);
    this.owners.clear();

    for (const [id, owner] of saved.owners) {
      this.owners.set(id, owner);
    }

    this.work.clear();

    for (const [id, work] of saved.work) {
      this.work.set(id, work);
    }

    this.services.clear();

    for (const [id, earned] of saved.services ?? []) {
      this.services.set(id, earned);
    }

    Object.assign(this.ledger, saved.ledger);
  }
}
