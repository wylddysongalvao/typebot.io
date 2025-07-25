import { TextInput } from "@/components/inputs";
import { queryClient, trpc } from "@/lib/queryClient";
import { toast } from "@/lib/toast";
import {
  Button,
  HStack,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
} from "@chakra-ui/react";
import { createId } from "@paralleldrive/cuid2";
import { useMutation } from "@tanstack/react-query";
import { useTranslate } from "@tolgee/react";
import type { ThemeTemplate } from "@typebot.io/theme/schemas";
import { type FormEvent, useRef, useState } from "react";

type Props = {
  workspaceId: string;
  isOpen: boolean;
  onClose: (template?: Pick<ThemeTemplate, "id" | "theme">) => void;
  selectedTemplate: Pick<ThemeTemplate, "id" | "name"> | undefined;
  theme: ThemeTemplate["theme"];
};

export const SaveThemeModal = ({
  workspaceId,
  isOpen,
  onClose,
  selectedTemplate,
  theme,
}: Props) => {
  const { t } = useTranslate();
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { mutate } = useMutation(
    trpc.theme.saveThemeTemplate.mutationOptions({
      onMutate: () => setIsSaving(true),
      onSettled: () => setIsSaving(false),
      onSuccess: ({ themeTemplate }) => {
        queryClient.invalidateQueries({
          queryKey: trpc.theme.listThemeTemplates.queryKey(),
        });
        onClose(themeTemplate);
      },
      onError: (error) => {
        toast({
          description: error.message,
        });
      },
    }),
  );

  const updateExistingTemplate = (e: FormEvent) => {
    e.preventDefault();
    const newName = inputRef.current?.value;
    if (!newName) return;
    mutate({
      name: newName,
      theme,
      workspaceId,
      themeTemplateId: selectedTemplate?.id ?? createId(),
    });
  };

  const saveNewTemplate = () => {
    const newName = inputRef.current?.value;
    if (!newName) return;
    mutate({
      name: newName,
      theme,
      workspaceId,
      themeTemplateId: createId(),
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} initialFocusRef={inputRef}>
      <ModalOverlay />
      <ModalContent as="form" onSubmit={updateExistingTemplate}>
        <ModalHeader>
          {t("theme.sideMenu.template.myTemplates.saveTheme.title")}
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <TextInput
            ref={inputRef}
            label={t("theme.sideMenu.template.myTemplates.saveTheme.name")}
            defaultValue={selectedTemplate?.name}
            withVariableButton={false}
            placeholder={t(
              "theme.sideMenu.template.myTemplates.saveTheme.myTemplate",
            )}
            isRequired
          />
        </ModalBody>

        <ModalFooter as={HStack}>
          {selectedTemplate?.id && (
            <Button isLoading={isSaving} onClick={saveNewTemplate}>
              {t("theme.sideMenu.template.myTemplates.saveTheme.saveAsNew")}
            </Button>
          )}
          <Button type="submit" colorScheme="orange" isLoading={isSaving}>
            {selectedTemplate?.id ? t("update") : t("save")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
