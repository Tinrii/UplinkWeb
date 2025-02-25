<script lang="ts">
    import { Appearance, Shape, Size } from "$lib/enums"
    import { type User } from "$lib/types"
    import { ProfilePicture } from "$lib/components"
    import { Button, Checkbox, Icon, Input, Label } from "$lib/elements"
    import Text from "$lib/elements/Text.svelte"
    import { _ } from "svelte-i18n"
    import { Store } from "$lib/state/Store"
    import Controls from "$lib/layouts/Controls.svelte"
    import { createEventDispatcher } from "svelte"
    import { RaygunStoreInstance } from "$lib/wasm/RaygunStore"

    export let embedded: boolean = false

    let name = ""
    let recipients: User[] = []
    let nameError = false
    let error: string | null = null

    function update_recipients(recipient: User) {
        let new_recipient_list = [...recipients]

        if (recipients.map(r => r.key).includes(recipient.key)) {
            new_recipient_list.splice(new_recipient_list.indexOf(recipient), 1)
        } else {
            new_recipient_list.push(recipient)
        }

        recipients = new_recipient_list

        // Clear error when the user updates the recipient list
        if (recipients.length > 0) {
            error = null
        }
    }

    function contains_recipient(list: User[], recipient: User): boolean {
        return list.map(r => r.key).includes(recipient.key)
    }

    function validateGroupName(name: string): boolean {
        if (name.trim().length === 0) {
            nameError = true
            return false
        } else {
            nameError = false
            return true
        }
    }

    $: friends = Store.getUsers(Store.state.friends)
    const dispatch = createEventDispatcher()

    async function onCreate() {
        if (recipients.length === 0) {
            // Validate before creating group chat
            error = $_("chat.group.noMembers") || "Please select at least one member."
            return
        }

        if (validateGroupName(name)) {
            let conversation = await RaygunStoreInstance.createGroupConversation(name, recipients)
            conversation.onSuccess(chat => {
                Store.setActiveChat(chat)
            })
            onCreateComplete()
        }
    }

    function onCreateComplete() {
        name = ""
        recipients = []
        error = null
        dispatch("create")
    }
</script>

<div class="new-chat" data-cy="modal-create-group-chat">
    <div class="select-user">
        <Label hook="label-create-group-name" text={$_("chat.group.name")} />
        <Input hook="input-create-group-name" alt bind:value={name} on:input={() => validateGroupName(name)} />

        <!-- Error message for invalid group name -->
        {#if nameError}
            <div class="error-message">
                <Text size={Size.Small} appearance={Appearance.Error}>
                    {$_("chat.group.error")}
                </Text>
            </div>
        {/if}

        <Label hook="label-create-group-members" text={$_("chat.group.members")} />
        <div class="user-list" data-cy="create-group-users-list">
            {#each recipients as recipient}
                <div class="mini-user" data-cy="mini-user">
                    <ProfilePicture hook="mini-user-profile-picture" id={recipient.key} size={Size.Smaller} noIndicator image={recipient.profile.photo.image} />
                    <Text hook="mini-user-name" singleLine size={Size.Small} appearance={Appearance.Alt}>
                        {recipient.name}
                    </Text>
                    <Button hook="mini-user-button" small outline icon on:click={() => update_recipients(recipient)}>
                        <Icon icon={Shape.XMark} alt class="control" />
                    </Button>
                </div>
            {/each}
        </div>

        <Label hook="label-create-group-select-members" text={$_("chat.group.select")} />
        <div class="user-selection-list {embedded ? 'embedded' : ''}" data-cy="user-selection-list">
            {#if $friends.length > 0}
                {#each $friends as recipient}
                    <button data-cy="single-user" class="user" on:click={() => update_recipients(recipient)}>
                        <ProfilePicture hook="single-user-profile-picture" id={recipient.key} size={Size.Small} image={recipient.profile.photo.image} status={recipient.profile.status} />
                        <div class="info" data-cy="single-user-info">
                            <Text hook="single-user-name" singleLine size={Size.Medium}>
                                {recipient.name}
                            </Text>
                            <Text hook="single-user-key" singleLine muted>
                                {recipient.key.replace("did:key:", "")}
                            </Text>
                        </div>
                        <Checkbox hook="single-user-checkbox" checked={contains_recipient(recipients, recipient)} />
                    </button>
                {/each}
            {:else}
                <Text hook="text-no-users" appearance={Appearance.Error} size={Size.Small}>
                    {$_("chat.group.noMembersAvailable")}
                </Text>
            {/if}
        </div>

        <!-- Display error message if no recipients are selected -->
        {#if error}
            <Text hook="text-error-create-group" appearance={Appearance.Error} size={Size.Small}>
                {error}
            </Text>
        {/if}

        <Controls>
            <Button hook="button-create-group" text={$_("chat.group.create")} fill disabled={nameError || recipients.length === 0 || $friends.length === 0} on:click={onCreate}>
                <Icon icon={Shape.ChatPlus} />
            </Button>
        </Controls>
    </div>
</div>

<style lang="scss">
    .new-chat {
        display: inline-flex;
        flex-direction: column;
        gap: var(--gap);
        width: 100%;
        height: fit-content;
        position: relative;
        justify-content: center;
        flex: 1;
        max-width: var(--max-component-width);

        .select-user {
            min-height: fit-content;
            flex: 1;
            padding: var(--gap);
            gap: var(--gap);
            display: inline-flex;
            flex-direction: column;
            position: relative;
            user-select: none;

            .user-list {
                display: inline-flex;
                flex-wrap: wrap;
                gap: var(--gap-less);
                background-color: var(--alt-color);
                padding: var(--padding-less);
                border-radius: var(--border-radius);
                border: var(--border-width) solid var(--border-color);
                height: fit-content;
                min-height: var(--input-height);

                .mini-user {
                    display: inline-flex;
                    gap: var(--gap-less);
                    align-items: center;
                    background-color: var(--primary-color);
                    color: var(--color-alt);
                    border-radius: var(--border-radius-more);
                    max-width: 150px;
                    font-size: var(--font-size-smaller);
                    border: var(--border-width-more) solid var(--primary-color);
                    height: fit-content;
                }
            }

            .user-selection-list {
                display: inline-flex;
                flex-direction: column;
                gap: var(--gap);
                min-height: var(--input-height);
                max-height: var(--min-scrollable-height);
                overflow-y: auto;
                overflow-x: hidden;
                padding-right: var(--padding-less);

                &.embedded {
                    flex: 1;
                    padding-right: unset;
                }
            }

            .user {
                display: inline-flex;
                gap: var(--gap);
                padding: var(--padding-less);
                padding-right: var(--padding);
                border-radius: var(--border-radius);
                border: var(--border-width) solid var(--border-radius);
                align-items: center;
                width: 100%;
                background-color: var(--alt-color);
                user-select: none;
                position: relative;
                color: var(--color);
                text-align: left;
                cursor: pointer;

                :global(input[type="checkbox"]:checked::after) {
                    content: "";
                    width: 100%;
                    height: 100%;
                    top: 0;
                    left: 0;
                    position: absolute;
                    border-radius: var(--border-radius);
                    border: var(--border-width) solid var(--info-color);
                    pointer-events: none;
                }

                &:hover {
                    background-color: var(--alt-color-alt);
                }

                .info {
                    display: inline-flex;
                    flex-direction: column;
                    flex: 1;
                    justify-content: center;
                    overflow: hidden;
                    pointer-events: none;
                    user-select: none;
                }
            }
        }
    }

    .error-message {
        margin-top: var(--gap-less);
    }
</style>
