<script lang="ts">
    import { Label, Text } from "$lib/elements"
    import { Size } from "$lib/enums"

    export let name: string = "Setting"
    export let description: string = "Some setting description"
    export let fullWidth: boolean = false
    export let hook: string = ""
    export let wrapContent: boolean = false
    export let small: boolean = false
</script>

<div data-cy={hook} class="setting-section {fullWidth ? 'full-width' : ''}">
    <div class="body">
        <div class="description">
            <Label small hook="setting-section-label" text={name} />
            <Text size={small ? Size.Smaller : Size.Medium} hook="setting-section-text" doubleLine>{description}</Text>
        </div>
        <div class="content {wrapContent ? 'wrap' : ''}">
            <slot></slot>
        </div>
    </div>
</div>

<style lang="scss">
    .setting-section {
        display: inline-flex;
        flex-direction: column;
        width: 100%;
        gap: var(--gap);
        padding: var(--padding-less) 0;
        align-items: center;

        .body {
            display: inline-flex;
            gap: var(--gap);
            width: 100%;
            align-items: center;
            flex-wrap: wrap;
            align-items: center;

            .description {
                flex: 1;
                min-width: 50%;
            }

            .content {
                width: fit-content;
                justify-content: flex-end;
                display: inline-flex;
                flex-direction: row;
                gap: var(--gap);
                align-items: center;

                &.wrap {
                    flex-wrap: wrap;
                }
            }
        }

        &.full-width {
            .body {
                .content {
                    width: 100%;
                }
            }
        }
    }

    @media (max-width: 800px) {
        .setting-section {
            .body {
                .content {
                    min-width: fit-content !important;
                }
            }
        }
    }
</style>
