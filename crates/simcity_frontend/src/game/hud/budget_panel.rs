//! The budget screen: where money comes from and where it goes, line by line, and the levers —
//! tax rates, service funding and loans (B5, D6).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::ui_state::GameUiRoot;
use simcity_sim::game::economy::{
    BudgetItem, BudgetLedger, BudgetLines, EconomyConfig, Loans, ServiceFunding, TaxRates, TaxZone,
    WealthClass,
};
use simcity_sim::game::services::ServiceKind;
use simcity_sim::game::sim::City;

use super::glass::GlassMaterial;
use super::hud_bar::{format_money, text_style};
use super::theme::Theme;

/// Whether the budget screen is open.
#[derive(Resource, Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BudgetPanelOpen(pub bool);

/// The panel whose visibility follows [`BudgetPanelOpen`].
#[derive(Component, Debug)]
pub struct BudgetPanel;

/// Where the panel's contents are rebuilt.
#[derive(Component, Debug)]
pub struct BudgetContent;

/// What a budget control does.
#[derive(Component, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetAction {
    Toggle,
    TaxDown(TaxZone, WealthClass),
    TaxUp(TaxZone, WealthClass),
    FundingDown(ServiceKind),
    FundingUp(ServiceKind),
    Borrow(i64),
}

/// A line's label as the player reads it.
pub fn budget_item_label(item: BudgetItem) -> &'static str {
    match item {
        BudgetItem::ResidentialTax => "Residential taxes",
        BudgetItem::CommercialTax => "Commercial taxes",
        BudgetItem::IndustrialTax => "Industrial taxes",
        BudgetItem::RoadMaintenance => "Road upkeep",
        BudgetItem::ServiceMaintenance => "Service upkeep",
        BudgetItem::UtilityMaintenance => "Utility upkeep",
        BudgetItem::Construction => "Construction",
        BudgetItem::LoanProceeds => "Loans received",
        BudgetItem::LoanRepayment => "Loan payments",
    }
}

/// Every line, income first, in the order the report reads.
const ITEMS: [BudgetItem; 9] = [
    BudgetItem::ResidentialTax,
    BudgetItem::CommercialTax,
    BudgetItem::IndustrialTax,
    BudgetItem::LoanProceeds,
    BudgetItem::RoadMaintenance,
    BudgetItem::ServiceMaintenance,
    BudgetItem::UtilityMaintenance,
    BudgetItem::Construction,
    BudgetItem::LoanRepayment,
];

const SERVICES: [(ServiceKind, &str, &str); 3] = [
    (ServiceKind::Fire, "fire", "Fire"),
    (ServiceKind::Police, "police", "Police"),
    (ServiceKind::Medical, "medical", "Medical"),
];

/// Spawn the budget screen, closed, under its own game-interface root.
pub fn spawn_budget_panel(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.budget.root"),
            GameUiRoot,
            // Layout only: it centres the panel, and the strip around it is map.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                top: space.px(18.0),
                left: Val::Px(0.0),
                right: Val::Px(0.0),
                justify_content: JustifyContent::Center,
                ..default()
            },
        ))
        .id();
    let panel = commands
        .spawn((
            Name::new("hud.budget"),
            BudgetPanel,
            Visibility::Hidden,
            GlobalZIndex(5),
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(3.0),
                width: Val::Px(560.0),
                padding: UiRect::all(space.px(4.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.panel)),
                ..default()
            },
            MaterialNode(glass),
            BoxShadow(vec![ShadowStyle {
                color: Color::srgba(0.0, 0.0, 0.0, 0.45),
                x_offset: Val::Px(0.0),
                y_offset: space.px(2.0),
                spread_radius: Val::Px(0.0),
                blur_radius: space.px(8.0),
            }]),
        ))
        .with_child((
            BudgetContent,
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(3.0),
                ..default()
            },
        ))
        .id();
    commands.entity(root).add_child(panel);
}

/// Spawn the HUD control that opens the budget screen, as a child of `parent`.
pub fn spawn_budget_toggle(commands: &mut Commands, theme: &Theme, parent: Entity) {
    let space = theme.space;
    let button = commands
        .spawn((
            Name::new("hud.budget.toggle"),
            BudgetAction::Toggle,
            Button,
            Node {
                padding: UiRect::new(space.px(2.0), space.px(2.0), space.px(1.0), space.px(1.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                ..default()
            },
            BackgroundColor(Color::NONE),
        ))
        .with_child((
            Text::new("Budget"),
            text_style(theme.type_scale.body, theme.palette.ink),
        ))
        .id();
    commands.entity(parent).add_child(button);
}

/// Carry out a budget control.
#[allow(clippy::too_many_arguments)]
pub fn on_budget_action(
    activate: On<Activate>,
    actions: Query<&BudgetAction>,
    mut open: ResMut<BudgetPanelOpen>,
    rates: Option<ResMut<TaxRates>>,
    funding: Option<ResMut<ServiceFunding>>,
    loans: Option<ResMut<Loans>>,
    ledger: Option<ResMut<BudgetLedger>>,
    city: Option<ResMut<City>>,
) {
    let Ok(action) = actions.get(activate.entity) else {
        return;
    };
    match *action {
        BudgetAction::Toggle => open.0 = !open.0,
        BudgetAction::TaxDown(zone, class) => {
            if let Some(mut rates) = rates {
                let rate = rates.get(zone, class).saturating_sub(1);
                rates.set(zone, class, rate);
            }
        }
        BudgetAction::TaxUp(zone, class) => {
            if let Some(mut rates) = rates {
                let rate = rates.get(zone, class).saturating_add(1);
                rates.set(zone, class, rate);
            }
        }
        BudgetAction::FundingDown(kind) => {
            if let Some(mut funding) = funding {
                let percent = funding.get(kind).saturating_sub(10);
                funding.set(kind, percent);
            }
        }
        BudgetAction::FundingUp(kind) => {
            if let Some(mut funding) = funding {
                let percent = funding.get(kind).saturating_add(10);
                funding.set(kind, percent);
            }
        }
        BudgetAction::Borrow(principal) => {
            if let (Some(mut loans), Some(mut ledger), Some(mut city)) = (loans, ledger, city) {
                // A refused loan leaves everything as it was; the loan list shows why there is
                // no new line.
                let _ = loans.take(principal, &mut ledger, &mut city);
            }
        }
    }
}

type BudgetPanels<'w, 's> = Query<'w, 's, &'static mut Visibility, With<BudgetPanel>>;
type BudgetContents<'w, 's> =
    Query<'w, 's, (Entity, Option<&'static Children>), With<BudgetContent>>;

/// Show or hide the panel and rebuild its contents when the budget changes.
#[allow(clippy::too_many_arguments)]
pub fn update_budget_panel(
    mut commands: Commands,
    open: Res<BudgetPanelOpen>,
    theme: Res<Theme>,
    city: Option<Res<City>>,
    cfg: Option<Res<EconomyConfig>>,
    ledger: Option<Res<BudgetLedger>>,
    rates: Option<Res<TaxRates>>,
    funding: Option<Res<ServiceFunding>>,
    loans: Option<Res<Loans>>,
    mut panels: BudgetPanels,
    contents: BudgetContents,
) {
    let wanted = if open.0 {
        Visibility::Inherited
    } else {
        Visibility::Hidden
    };
    for mut visibility in &mut panels {
        visibility.set_if_neq(wanted);
    }
    if !open.0 {
        return;
    }
    let (Some(city), Some(cfg), Some(ledger), Some(rates), Some(funding), Some(loans)) =
        (city, cfg, ledger, rates, funding, loans)
    else {
        return;
    };
    let changed = open.is_changed()
        || theme.is_changed()
        || ledger.is_changed()
        || rates.is_changed()
        || funding.is_changed()
        || loans.is_changed();
    if !changed {
        return;
    }

    for (content, children) in &contents {
        for child in children.into_iter().flat_map(|children| children.iter()) {
            commands.entity(child).despawn();
        }
        let mut ui = BudgetUi {
            commands: &mut commands,
            theme: &theme,
            parent: content,
        };
        ui.header(&city, &cfg, &ledger);
        ui.lines(
            &ledger.current,
            ledger.last.as_ref().map(|report| &report.lines),
        );
        ui.tax_rates(&rates);
        ui.funding(&funding);
        ui.loans(&loans);
    }
}

/// Builds the rows of the budget screen under one parent.
struct BudgetUi<'a, 'w, 's> {
    commands: &'a mut Commands<'w, 's>,
    theme: &'a Theme,
    parent: Entity,
}

impl BudgetUi<'_, '_, '_> {
    fn text(&mut self, text: impl Into<String>, size: f32, color: Color) -> Entity {
        self.commands
            .spawn((Text::new(text.into()), text_style(size, color)))
            .id()
    }

    fn cell(&mut self, content: Entity, width: f32, end: bool) -> Entity {
        let justify = if end {
            JustifyContent::End
        } else {
            JustifyContent::Start
        };
        let cell = self
            .commands
            .spawn(Node {
                width: Val::Px(width),
                justify_content: justify,
                ..default()
            })
            .id();
        self.commands.entity(cell).add_child(content);
        cell
    }

    fn row(&mut self, cells: &[Entity]) -> Entity {
        let row = self
            .commands
            .spawn(Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                column_gap: self.theme.space.px(2.0),
                ..default()
            })
            .id();
        self.commands.entity(row).add_children(cells);
        self.commands.entity(self.parent).add_child(row);
        row
    }

    fn heading(&mut self, title: &str) {
        let text = self.text(
            title,
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        self.row(&[text]);
    }

    fn amount(&mut self, amount: Option<i64>) -> Entity {
        let palette = self.theme.palette;
        let (label, color) = match amount {
            None => ("-".to_string(), palette.ink_muted),
            Some(amount) if amount < 0 => (format_money(amount), palette.negative),
            Some(amount) => (format_money(amount), palette.ink),
        };
        let text = self.text(label, self.theme.type_scale.body, color);
        self.cell(text, 120.0, true)
    }

    fn button(&mut self, name: String, action: BudgetAction, label: &str) -> Entity {
        let space = self.theme.space;
        self.commands
            .spawn((
                Name::new(name),
                action,
                Button,
                Node {
                    padding: UiRect::new(
                        space.px(2.0),
                        space.px(2.0),
                        space.px(0.5),
                        space.px(0.5),
                    ),
                    border_radius: BorderRadius::all(Val::Px(self.theme.radii.control)),
                    ..default()
                },
                BackgroundColor(self.theme.palette.glass_highlight),
            ))
            .with_child((
                Text::new(label),
                text_style(self.theme.type_scale.body, self.theme.palette.ink),
            ))
            .id()
    }

    fn header(&mut self, city: &City, cfg: &EconomyConfig, ledger: &BudgetLedger) {
        let title = self.text(
            "Budget",
            self.theme.type_scale.title,
            self.theme.palette.ink,
        );
        let month = self.text(
            format!(
                "Month {}, day {} of {}",
                ledger.month + 1,
                ledger.days_elapsed,
                cfg.days_per_month.max(1)
            ),
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        let treasury = self.text(
            format!("Treasury {}", format_money(city.money)),
            self.theme.type_scale.body,
            if city.money < 0 {
                self.theme.palette.negative
            } else {
                self.theme.palette.ink
            },
        );
        self.row(&[title, month, treasury]);
    }

    fn lines(&mut self, current: &BudgetLines, last: Option<&BudgetLines>) {
        let blank = self.text(
            "",
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        let blank = self.cell(blank, 180.0, false);
        let this_month = self.text(
            "This month",
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        let this_month = self.cell(this_month, 120.0, true);
        let last_month = self.text(
            "Last month",
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        let last_month = self.cell(last_month, 120.0, true);
        self.row(&[blank, this_month, last_month]);

        for item in ITEMS {
            let label = self.text(
                budget_item_label(item),
                self.theme.type_scale.body,
                self.theme.palette.ink,
            );
            let label = self.cell(label, 180.0, false);
            let now = self.amount(Some(current.get(item)));
            let before = self.amount(last.map(|lines| lines.get(item)));
            self.row(&[label, now, before]);
        }

        let net = self.text("Net", self.theme.type_scale.body, self.theme.palette.ink);
        let net = self.cell(net, 180.0, false);
        let now = self.amount(Some(current.total()));
        let before = self.amount(last.map(BudgetLines::total));
        self.row(&[net, now, before]);
    }

    fn tax_rates(&mut self, rates: &TaxRates) {
        self.heading("Tax rates");
        let mut header = vec![];
        let blank = self.text(
            "",
            self.theme.type_scale.caption,
            self.theme.palette.ink_muted,
        );
        header.push(self.cell(blank, 120.0, false));
        for class in WealthClass::ALL {
            let label = self.text(
                format!("{class:?}"),
                self.theme.type_scale.caption,
                self.theme.palette.ink_muted,
            );
            header.push(self.cell(label, 120.0, false));
        }
        self.row(&header);

        for zone in TaxZone::ALL {
            let zone_name = format!("{zone:?}").to_lowercase();
            let label = self.text(
                format!("{zone:?}"),
                self.theme.type_scale.body,
                self.theme.palette.ink,
            );
            let mut cells = vec![self.cell(label, 120.0, false)];
            for class in WealthClass::ALL {
                let class_name = format!("{class:?}").to_lowercase();
                let down = self.button(
                    format!("hud.budget.tax.{zone_name}.{class_name}.down"),
                    BudgetAction::TaxDown(zone, class),
                    "-",
                );
                let value = self.text(
                    format!("{}%", rates.get(zone, class)),
                    self.theme.type_scale.body,
                    self.theme.palette.ink,
                );
                let up = self.button(
                    format!("hud.budget.tax.{zone_name}.{class_name}.up"),
                    BudgetAction::TaxUp(zone, class),
                    "+",
                );
                let group = self
                    .commands
                    .spawn(Node {
                        width: Val::Px(120.0),
                        flex_direction: FlexDirection::Row,
                        align_items: AlignItems::Center,
                        column_gap: self.theme.space.px(1.0),
                        ..default()
                    })
                    .id();
                self.commands.entity(group).add_children(&[down, value, up]);
                cells.push(group);
            }
            self.row(&cells);
        }
    }

    fn funding(&mut self, funding: &ServiceFunding) {
        self.heading("Service funding");
        for (kind, name, label) in SERVICES {
            let label = self.text(label, self.theme.type_scale.body, self.theme.palette.ink);
            let label = self.cell(label, 120.0, false);
            let down = self.button(
                format!("hud.budget.funding.{name}.down"),
                BudgetAction::FundingDown(kind),
                "-",
            );
            let value = self.text(
                format!("{}%", funding.get(kind)),
                self.theme.type_scale.body,
                self.theme.palette.ink,
            );
            let up = self.button(
                format!("hud.budget.funding.{name}.up"),
                BudgetAction::FundingUp(kind),
                "+",
            );
            self.row(&[label, down, value, up]);
        }
    }

    fn loans(&mut self, loans: &Loans) {
        self.heading("Loans");
        let mut offers = vec![];
        for principal in Loans::SIZES {
            offers.push(self.button(
                format!("hud.budget.loan.{principal}"),
                BudgetAction::Borrow(principal),
                &format!("Borrow {}", format_money(principal)),
            ));
        }
        self.row(&offers);
        if loans.active.is_empty() {
            let none = self.text(
                "No open loans",
                self.theme.type_scale.caption,
                self.theme.palette.ink_muted,
            );
            self.row(&[none]);
        }
        for loan in &loans.active {
            let line = self.text(
                format!(
                    "{} loan: {} a month, {} months left",
                    format_money(loan.principal),
                    format_money(loan.monthly_payment),
                    loan.months_left
                ),
                self.theme.type_scale.body,
                self.theme.palette.ink,
            );
            self.row(&[line]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget_app() -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.init_resource::<BudgetPanelOpen>();
        app.insert_resource(City {
            money: 12_000,
            ..default()
        });
        app.insert_resource(EconomyConfig::default());
        let mut ledger = BudgetLedger::default();
        ledger.restart(12_000);
        app.insert_resource(ledger);
        app.init_resource::<TaxRates>();
        app.init_resource::<ServiceFunding>();
        app.init_resource::<Loans>();
        app.add_observer(on_budget_action);
        app.add_systems(Update, update_budget_panel);
        let theme = Theme::default();
        let world = app.world_mut();
        let hud = world.spawn(Node::default()).id();
        spawn_budget_toggle(&mut world.commands(), &theme, hud);
        spawn_budget_panel(&mut world.commands(), &theme, Handle::default());
        world.flush();
        app.update();
        app
    }

    fn named(app: &mut App, name: &str) -> Entity {
        app.world_mut()
            .query::<(Entity, &Name)>()
            .iter(app.world())
            .find(|(_, entity_name)| entity_name.as_str() == name)
            .map(|(entity, _)| entity)
            .unwrap_or_else(|| panic!("nothing is named {name}"))
    }

    fn press(app: &mut App, name: &str) {
        let entity = named(app, name);
        assert!(
            app.world().get::<Button>(entity).is_some(),
            "{name} is a button"
        );
        app.world_mut().trigger(Activate { entity });
        app.update();
    }

    fn panel_open(app: &mut App) -> bool {
        let world = app.world_mut();
        let visibility = world
            .query_filtered::<&Visibility, With<BudgetPanel>>()
            .single(world)
            .expect("one budget panel");
        *visibility != Visibility::Hidden
    }

    fn texts(app: &mut App) -> Vec<String> {
        app.world_mut()
            .query::<&Text>()
            .iter(app.world())
            .map(|text| text.0.clone())
            .collect()
    }

    #[test]
    fn ui_shell_budget_opens_and_closes_from_the_hud() {
        let mut app = budget_app();
        assert!(!panel_open(&mut app), "the budget starts closed");
        press(&mut app, "hud.budget.toggle");
        assert!(panel_open(&mut app));
        press(&mut app, "hud.budget.toggle");
        assert!(!panel_open(&mut app));

        let world = app.world_mut();
        let pickable = world
            .query_filtered::<Option<&Pickable>, With<GameUiRoot>>()
            .single(world)
            .expect("one budget root")
            .copied()
            .expect("a layout root says how it treats the pointer");
        assert!(!pickable.is_hoverable && !pickable.should_block_lower);
    }

    #[test]
    fn ui_shell_budget_shows_this_and_last_month_line_by_line() {
        let mut app = budget_app();
        {
            let world = app.world_mut();
            let mut city = world.resource::<City>().clone();
            let mut ledger = world.resource::<BudgetLedger>().clone();
            ledger.post(BudgetItem::Construction, -120, &mut city);
            ledger.end_of_day(1, &city);
            ledger.post(BudgetItem::ResidentialTax, 240, &mut city);
            ledger.post(BudgetItem::RoadMaintenance, -35, &mut city);
            world.insert_resource(ledger);
            world.insert_resource(city);
        }
        press(&mut app, "hud.budget.toggle");
        let shown = texts(&mut app);
        for expected in [
            budget_item_label(BudgetItem::ResidentialTax),
            budget_item_label(BudgetItem::RoadMaintenance),
            budget_item_label(BudgetItem::Construction),
            "$240",
            "-$35",
            "-$120",
            "This month",
            "Last month",
            "$12 085",
        ] {
            assert!(
                !expected.is_empty() && shown.iter().any(|text| text.contains(expected)),
                "the budget should show `{expected}`: {shown:?}"
            );
        }
    }

    #[test]
    fn ui_shell_budget_tax_buttons_step_one_rate_by_a_point() {
        let mut app = budget_app();
        press(&mut app, "hud.budget.toggle");
        press(&mut app, "hud.budget.tax.commercial.high.up");
        let rates = app.world().resource::<TaxRates>().clone();
        assert_eq!(rates.get(TaxZone::Commercial, WealthClass::High), 10);
        assert_eq!(rates.get(TaxZone::Commercial, WealthClass::Low), 9);
        press(&mut app, "hud.budget.tax.commercial.high.down");
        press(&mut app, "hud.budget.tax.commercial.high.down");
        assert_eq!(
            app.world()
                .resource::<TaxRates>()
                .get(TaxZone::Commercial, WealthClass::High),
            8
        );
        assert!(
            texts(&mut app).iter().any(|text| text == "8%"),
            "the rate on screen follows the rate in force"
        );
    }

    #[test]
    fn ui_shell_budget_funding_buttons_step_ten_percent() {
        let mut app = budget_app();
        press(&mut app, "hud.budget.toggle");
        press(&mut app, "hud.budget.funding.police.down");
        assert_eq!(
            app.world()
                .resource::<ServiceFunding>()
                .get(ServiceKind::Police),
            90
        );
        press(&mut app, "hud.budget.funding.medical.up");
        assert_eq!(
            app.world()
                .resource::<ServiceFunding>()
                .get(ServiceKind::Medical),
            110
        );
    }

    #[test]
    fn ui_shell_budget_borrowing_puts_money_in_the_treasury() {
        let mut app = budget_app();
        press(&mut app, "hud.budget.toggle");
        press(&mut app, "hud.budget.loan.10000");
        assert_eq!(app.world().resource::<City>().money, 22_000);
        assert_eq!(app.world().resource::<Loans>().active.len(), 1);
        assert_eq!(
            app.world()
                .resource::<BudgetLedger>()
                .current
                .get(BudgetItem::LoanProceeds),
            10_000
        );
        assert!(
            texts(&mut app)
                .iter()
                .any(|text| text.contains("12 months")),
            "the open loan is listed"
        );
    }
}
