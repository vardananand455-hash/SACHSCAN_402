export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analysis_results: {
        Row: {
          ai_probability: number | null
          authenticity_confidence: number | null
          created_at: string | null
          file_hash: string | null
          findings: Json | null
          id: string
          investigation_id: string | null
          manipulation_probability: number | null
          risk_level: string | null
          signals: Json | null
        }
        Insert: {
          ai_probability?: number | null
          authenticity_confidence?: number | null
          created_at?: string | null
          file_hash?: string | null
          findings?: Json | null
          id?: string
          investigation_id?: string | null
          manipulation_probability?: number | null
          risk_level?: string | null
          signals?: Json | null
        }
        Update: {
          ai_probability?: number | null
          authenticity_confidence?: number | null
          created_at?: string | null
          file_hash?: string | null
          findings?: Json | null
          id?: string
          investigation_id?: string | null
          manipulation_probability?: number | null
          risk_level?: string | null
          signals?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_results_investigation_id_fkey"
            columns: ["investigation_id"]
            isOneToOne: false
            referencedRelation: "investigations"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence: {
        Row: {
          created_at: string | null
          file_hash: string | null
          file_name: string | null
          file_size: number | null
          file_type: string | null
          file_url: string | null
          height: number | null
          id: string
          investigation_id: string | null
          width: number | null
        }
        Insert: {
          created_at?: string | null
          file_hash?: string | null
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          height?: number | null
          id?: string
          investigation_id?: string | null
          width?: number | null
        }
        Update: {
          created_at?: string | null
          file_hash?: string | null
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          height?: number | null
          id?: string
          investigation_id?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "evidence_investigation_id_fkey"
            columns: ["investigation_id"]
            isOneToOne: false
            referencedRelation: "investigations"
            referencedColumns: ["id"]
          },
        ]
      }
      investigations: {
        Row: {
          ai_probability: number | null
          authenticity_confidence: number | null
          case_id: string
          created_at: string | null
          evidence_description: string | null
          evidence_name: string | null
          evidence_type: string | null
          id: string
          investigator_name: string | null
          is_demo: boolean | null
          manipulation_probability: number | null
          metadata_status: string | null
          risk_level: string | null
          source_trace_status: string | null
          status: string | null
          summary: string | null
          user_id: string | null
        }
        Insert: {
          ai_probability?: number | null
          authenticity_confidence?: number | null
          case_id: string
          created_at?: string | null
          evidence_description?: string | null
          evidence_name?: string | null
          evidence_type?: string | null
          id?: string
          investigator_name?: string | null
          is_demo?: boolean | null
          manipulation_probability?: number | null
          metadata_status?: string | null
          risk_level?: string | null
          source_trace_status?: string | null
          status?: string | null
          summary?: string | null
          user_id?: string | null
        }
        Update: {
          ai_probability?: number | null
          authenticity_confidence?: number | null
          case_id?: string
          created_at?: string | null
          evidence_description?: string | null
          evidence_name?: string | null
          evidence_type?: string | null
          id?: string
          investigator_name?: string | null
          is_demo?: boolean | null
          manipulation_probability?: number | null
          metadata_status?: string | null
          risk_level?: string | null
          source_trace_status?: string | null
          status?: string | null
          summary?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      source_matches: {
        Row: {
          confidence: number | null
          created_at: string | null
          discovered_date: string | null
          id: string
          investigation_id: string | null
          is_demo: boolean | null
          similarity_score: number | null
          source_name: string | null
          source_url: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          discovered_date?: string | null
          id?: string
          investigation_id?: string | null
          is_demo?: boolean | null
          similarity_score?: number | null
          source_name?: string | null
          source_url?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          discovered_date?: string | null
          id?: string
          investigation_id?: string | null
          is_demo?: boolean | null
          similarity_score?: number | null
          source_name?: string | null
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_matches_investigation_id_fkey"
            columns: ["investigation_id"]
            isOneToOne: false
            referencedRelation: "investigations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
