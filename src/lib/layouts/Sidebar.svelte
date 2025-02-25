<script lang="ts">
    import { routes } from "$lib/defaults/routes"
    import Navigation from "./Navigation.svelte"
    import { Input, Icon, Button } from "$lib/elements"
    import { CallControls } from "$lib/components"
    import { Appearance, Route, Shape } from "$lib/enums"
    import { createEventDispatcher } from "svelte"
    import { goto } from "$app/navigation"
    import { _ } from "svelte-i18n"
    import { get } from "svelte/store"
    import { Store } from "$lib/state/Store"
    import type { Call } from "$lib/types"
    import { Slimbar } from "."
    import WidgetBar from "$lib/components/widgets/WidgetBar.svelte"
    import { SettingsStore, type ISettingsState } from "$lib/state"
    import { isAndroidOriOS } from "$lib/utils/Mobile"
    import { slide } from "svelte/transition"
    import { sidebarSlideDuration } from "$lib/globals/animations"

    export let activeRoute: Route = Route.Chat
    export let open: boolean = true
    export let loading: boolean = true
    export let activeCall: Call | null = get(Store.state.activeCall)

    export let search: string = ""
    let settings: ISettingsState = get(SettingsStore.state)
    SettingsStore.state.subscribe((s: ISettingsState) => {
        settings = s
    })

    const dispatch = createEventDispatcher()
    function handleToggle() {
        dispatch("toggle", open)
    }

    function handleEnter() {
        dispatch("enter", search)
    }

    function handleSearch() {
        dispatch("search", search)
    }

    Store.state.activeCall.subscribe(c => (activeCall = c))
</script>

<div class="sidebar-layout {open ? 'open' : 'closed'}" data-cy="sidebar">
    <Slimbar sidebarOpen={open} on:toggle={handleToggle} activeRoute={activeRoute}></Slimbar>

    {#if open}
        <div class="sidebar" in:slide={{ duration: sidebarSlideDuration, axis: "x" }} out:slide={{ duration: sidebarSlideDuration, axis: "x" }}>
            <div class="sidebar-pre">
                <Input hook="input-sidebar-search" alt autoFocus={false} placeholder={$_("generic.search_placeholder")} bind:value={search} on:enter={handleEnter} on:input={handleSearch}>
                    <Icon icon={Shape.Search} />
                </Input>

                <Button hook="button-hide-sidebar" icon appearance={Appearance.Alt} on:click={handleToggle} loading={loading}>
                    <Icon icon={Shape.Sidebar} />
                </Button>
            </div>

            <div class="sidebar-content">
                <!-- Commenting out the Marketplace button -->
                <!--
                <Button
                    appearance={Appearance.Alt}
                    on:click={() => {
                        UIStore.toggleMarket()
                    }}
                    text="Marketplace"
                    outline>
                    <Icon icon={Shape.Shop} />
                </Button>
                -->

                {#if settings && settings.widgets && settings.widgets.show}
                    <WidgetBar />
                {/if}

                <slot></slot>
            </div>

            <div class="popups">
                <CallControls activeRoute={activeRoute} />
            </div>
            {#if !isAndroidOriOS()}
                <Navigation icons routes={routes} activeRoute={activeRoute} on:navigate={e => goto(e.detail)} />
            {/if}
        </div>
    {/if}
</div>

<style lang="scss">
    .sidebar-layout {
        top: 0;
        left: 0;
        z-index: 5;
        height: 100%;
        background-color: var(--background);
        opacity: 1;
        width: fit-content;
        display: inline-flex;
        flex-direction: row;
        border-right: var(--border-width) solid var(--border-color);
        max-height: 100vh;
        overflow-y: hidden;

        .sidebar {
            display: inline-flex;
            flex-direction: column;
            padding: var(--padding-less);
            width: var(--sidebar-width);
            gap: var(--gap);
            flex: 1;
        }

        .sidebar-content {
            display: flex;
            flex-direction: column;
            padding-right: var(--gap);
            flex: 1;
            width: 100%;
            overflow-y: scroll;
            overflow-x: hidden;
            gap: var(--gap);
        }

        .sidebar-pre {
            width: 100%;
            display: inline-flex;
            gap: var(--gap);
            align-items: center;
        }
    }

    @media (max-width: 800px) {
        .sidebar-layout {
            position: absolute;
            width: 100vw;
            overflow: hidden;
            opacity: 1;
            transition:
                transform 0.3s ease,
                opacity 0.3s ease;

            .sidebar {
                min-width: 0;
            }
        }

        .sidebar-layout.closed {
            transform: translateX(-100%);
            pointer-events: none;
            :global(.slimbar) {
                opacity: 0;
                pointer-events: none;
            }
        }
    }
</style>
