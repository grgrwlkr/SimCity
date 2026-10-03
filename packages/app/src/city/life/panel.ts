import type {Activity, LifeFrame, LifeProfile} from './types';
import {INITIAL_MINUTE, MINUTE_SECONDS} from './population';

const activities: Record<Activity, string> = {
  train: 'В поезде',
  home: 'Дома',
  walk: 'Идёт пешком',
  drive: 'В дороге',
  work: 'На работе',
  shop: 'За покупками',
  leisure: 'Отдыхает',
  school: 'В школе',
  garage: 'У машины',
  dead: 'Умер',
};
const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const time = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.floor(minute) % 60).padStart(2, '0')}`;

export interface LifeActions {
  select(id: number | null): void;
  follow(on: boolean): void;
  focus(x: number, z: number): void;
  parking(on: boolean): void;
  speed(value: number): void;
  save(): Promise<void>;
  load(): Promise<void>;
}
export class LifePanel {
  readonly root = document.createElement('div');
  private frame: LifeFrame | null = null;
  private catalogSize = -1;
  private detailSignature = '';
  private selected: number | null = null;
  private facility: number | null = null;
  private following = false;
  private parkingVisible = false;

  constructor(
    private profile: LifeProfile,
    private actions: LifeActions,
  ) {
    this.root.className = 'life-interface';
    this.root.innerHTML = `<section class="life-clock" aria-label="Жизнь города"><div class="life-timestamp"><strong id="life-time">07:30</strong><span id="life-day">День 1 · Пн</span></div><div class="life-speeds" aria-label="Скорость жизни"><button data-speed="1" aria-pressed="true">×1</button><button data-speed="5" aria-pressed="false">×5</button><button data-speed="20" aria-pressed="false">×20</button></div><button id="life-open" aria-expanded="false">Жители <b id="life-count">…</b></button><button id="parking-toggle" aria-pressed="false">P <span>Парковки</span></button></section>
    <section id="residents-panel" class="residents-panel" aria-label="Жители и семьи" hidden><div class="life-heading"><strong>Жители и семьи</strong><button id="life-close" aria-label="Закрыть жителей">×</button></div><p class="life-muted" id="life-summary"></p><label for="resident-select">Чья сегодня история?</label><select id="resident-select" aria-label="Житель города"><option value="">Выберите жителя</option></select><div id="resident-details" hidden><div class="resident-heading"><h2 id="resident-name"></h2><span id="resident-activity"></span></div><p id="resident-destination"></p><p class="life-muted" id="resident-decision"></p><button id="resident-follow" class="build-action" aria-pressed="false">Следовать за жителем</button><dl class="resident-facts"><div><dt>Семейный бюджет</dt><dd id="resident-money"></dd></div><div><dt>Возраст</dt><dd id="resident-age"></dd></div><div><dt>Жильё</dt><dd><button id="resident-home"></button></dd></div><div><dt>Работа</dt><dd id="resident-job"></dd></div></dl><p id="resident-car"></p><h3>Семья</h3><div id="resident-family"></div><h3>События</h3><ol id="resident-events"></ol></div><div class="life-storage"><button id="life-save">Сохранить</button><button id="life-load">Загрузить</button></div><p class="life-muted" id="life-save-status" role="status">Сохранение хранится на этом устройстве.</p></section>
    <section id="parking-panel" class="parking-panel" aria-label="Парковки города" hidden><div class="life-heading"><strong id="parking-title">Парковки города</strong><button id="parking-close" aria-label="Закрыть парковки">×</button></div><p id="parking-count"></p><p id="parking-detail" class="life-muted">Нажмите на место или въезд, чтобы узнать, кому оно доступно.</p><div class="parking-key"><span>● Свободно</span><span>● Занято</span><span>● Манёвр</span></div></section>`;
    document.querySelector('main')!.append(this.root);
    this.el('life-open').addEventListener('click', () =>
      this.open(this.el('residents-panel').hidden !== false),
    );
    this.el('life-close').addEventListener('click', () => this.open(false));
    this.el('resident-select').addEventListener('change', () => {
      const value = (this.el('resident-select') as HTMLSelectElement).value;

      this.select(value === '' ? null : Number(value));
    });
    this.el('resident-follow').addEventListener('click', () => {
      this.following = !this.following;
      this.actions.follow(this.following);
      this.syncFollow();
    });
    this.el('resident-home').addEventListener('click', () => {
      if (this.frame?.selected) {
        const home = this.frame.selected.home;

        this.actions.focus(home.door.x, home.door.z);
        this.following = false;
        this.syncFollow();
      }
    });

    for (const b of this.root.querySelectorAll<HTMLButtonElement>(
      '[data-speed]',
    )) {
      b.addEventListener('click', () => {
        this.actions.speed(Number(b.dataset['speed']));

        for (const other of this.root.querySelectorAll('[data-speed]')) {
          other.setAttribute('aria-pressed', String(other === b));
        }
      });
    }

    this.el('parking-toggle').addEventListener('click', () =>
      this.showParking(!this.parkingVisible),
    );
    this.el('parking-close').addEventListener('click', () =>
      this.showParking(false),
    );

    for (const kind of ['save', 'load'] as const) {
      this.el(`life-${kind}`).addEventListener('click', () => {
        this.message(kind === 'save' ? 'Сохраняю…' : 'Загружаю…');
        void this.actions[kind]()
          .then(() =>
            this.message(
              kind === 'save'
                ? 'Город сохранён на этом устройстве.'
                : 'Жизнь города восстановлена.',
            ),
          )
          .catch((error: Error) => this.message(error.message));
      });
    }
  }

  private el(id: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`#${id}`)!;
  }

  private text(id: string, value: string): void {
    const el = this.el(id);

    if (el.textContent !== value) {
      el.textContent = value;
    }
  }

  private syncFollow(): void {
    this.el('resident-follow').setAttribute(
      'aria-pressed',
      String(this.following),
    );
    this.text(
      'resident-follow',
      this.following ? 'Перестать следовать' : 'Следовать за жителем',
    );
  }

  stopFollowing(): void {
    this.following = false;
    this.actions.follow(false);
    this.syncFollow();
  }

  message(value: string): void {
    this.text('life-save-status', value);
  }

  open(value: boolean): void {
    this.el('residents-panel').hidden = !value;
    this.el('life-open').setAttribute('aria-expanded', String(value));
    document.body.classList.toggle('is-inspecting-life', value);
  }

  select(id: number | null): void {
    this.selected = id;
    this.open(true);
    this.actions.select(id);
  }

  showParking(value: boolean): void {
    this.parkingVisible = value;
    this.el('parking-panel').hidden = !value;
    this.el('parking-toggle').setAttribute('aria-pressed', String(value));
    this.actions.parking(value);
  }

  inspectParking(id: number): void {
    this.facility = id;
    this.showParking(true);

    if (this.frame) {
      this.update(this.frame);
    }
  }

  get parkingEnabled(): boolean {
    return this.parkingVisible;
  }

  update(frame: LifeFrame): void {
    this.frame = frame;
    this.text('life-time', time(frame.minute));
    this.text(
      'life-day',
      `День ${frame.day} · ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][(frame.day - 1) % 7]}`,
    );
    this.text('life-count', String(frame.population));
    this.text(
      'life-summary',
      `${frame.families} семей · ${frame.employed} работают · ${frame.walking} пешком · ${frame.driving} за рулём`,
    );

    if (this.catalogSize !== frame.catalog.length) {
      this.catalogSize = frame.catalog.length;
      const select = this.el('resident-select') as HTMLSelectElement;

      select.replaceChildren(
        new Option('Выберите жителя', ''),
        ...frame.catalog.map(p => new Option(p.name, String(p.id))),
      );
      select.value = this.selected === null ? '' : String(this.selected);
    }

    const details = frame.selected;

    this.el('resident-details').hidden = !details;

    if (details) {
      this.selected = details.person.id;
      (this.el('resident-select') as HTMLSelectElement).value = String(
        this.selected,
      );
      const signature = JSON.stringify({
        ...details,
        person: {
          ...details.person,
          position: null,
          trip: details.person.trip
            ? {
                purpose: details.person.trip.purpose,
                leg: details.person.trip.leg,
              }
            : null,
        },
      });

      if (signature !== this.detailSignature) {
        this.detailSignature = signature;
        this.text('resident-name', details.person.name);
        this.text('resident-activity', activities[details.person.activity]);
        this.text('resident-destination', details.destination);
        this.text('resident-decision', details.next);
        this.text('resident-money', money(details.family.balance));
        this.text('resident-age', `${details.age} лет`);
        this.text(
          'resident-home',
          `${details.home.name} · ${details.ownsHome ? 'в собственности' : 'аренда'}`,
        );
        this.text(
          'resident-job',
          details.person.job
            ? `${details.person.job.title} · ${money(details.person.job.wage)} / смена`
            : details.age < 18
              ? 'Растёт и учится'
              : 'Нет работы',
        );
        this.text(
          'resident-car',
          details.cars.length
            ? details.cars
                .map(
                  c =>
                    `${c.name}: ${c.place}${c.driver !== null ? ` · за рулём ${details.members.find(m => m.id === c.driver)?.name ?? 'член семьи'}` : ''}`,
                )
                .join('\n')
            : 'В семье пока нет машины',
        );
        this.el('resident-family').replaceChildren(
          ...details.members.map(member => {
            const b = document.createElement('button');

            b.textContent = `${member.name}, ${member.age} · ${activities[member.activity]}`;
            b.setAttribute('aria-pressed', String(member.id === this.selected));
            b.addEventListener('click', () => this.select(member.id));

            return b;
          }),
        );
        this.el('resident-events').replaceChildren(
          ...details.person.history
            .slice(-6)
            .reverse()
            .map(event => {
              const li = document.createElement('li');

              li.textContent = `${time(INITIAL_MINUTE + event.at / MINUTE_SECONDS)} · ${event.text}`;

              return li;
            }),
        );
      }
    }

    const facility =
      this.facility === null ? null : this.profile.facilities[this.facility]!;
    const slots = facility
      ? frame.parking.filter(s => facility.slots.includes(s.id))
      : frame.parking;
    const occupied = slots.filter(s => s.occupant !== null).length;
    const reserved = slots.filter(s => s.reserved !== null).length;

    this.text('parking-title', facility?.name ?? 'Парковки города');
    this.text(
      'parking-count',
      `${slots.length - occupied - reserved} свободно · ${occupied} занято · ${reserved} ожидают машину`,
    );

    if (facility) {
      this.text(
        'parking-detail',
        facility.kind === 'private'
          ? 'Место закреплено за семьёй этого дома.'
          : facility.residentsOnly
            ? 'Подземный паркинг для жителей квартала.'
            : `Доступно всем · ${money(facility.fee)} за посещение.`,
      );
    }
  }

  dispose(): void {
    this.root.remove();
    document.body.classList.remove('is-inspecting-life');
  }
}
