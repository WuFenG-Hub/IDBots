import { ProjectFormData, ProjectRecord } from '../types/project';

class ProjectsService {
  private projects: ProjectRecord[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadProjects();
    this.initialized = true;
  }

  async loadProjects(): Promise<ProjectRecord[]> {
    try {
      const result = await window.electron.projects.list();
      if (result.success && result.projects) {
        this.projects = result.projects;
      } else {
        this.projects = [];
      }
      return this.projects;
    } catch (error) {
      console.error('Failed to load projects:', error);
      this.projects = [];
      return this.projects;
    }
  }

  async createProject(data: ProjectFormData): Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }> {
    try {
      const result = await window.electron.projects.create(data);
      if (result.success && result.projects) {
        this.projects = result.projects;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project';
      console.error('Failed to create project:', error);
      return { success: false, error: message };
    }
  }

  async updateProject(id: string, data: Partial<ProjectFormData>): Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }> {
    try {
      const result = await window.electron.projects.update(id, data);
      if (result.success && result.projects) {
        this.projects = result.projects;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update project';
      console.error('Failed to update project:', error);
      return { success: false, error: message };
    }
  }

  async deleteProject(id: string): Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }> {
    try {
      const result = await window.electron.projects.delete(id);
      if (result.success && result.projects) {
        this.projects = result.projects;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete project';
      console.error('Failed to delete project:', error);
      return { success: false, error: message };
    }
  }

  async setProjectEnabled(id: string, enabled: boolean): Promise<ProjectRecord[]> {
    try {
      const result = await window.electron.projects.setEnabled({ id, enabled });
      if (result.success && result.projects) {
        this.projects = result.projects;
        return this.projects;
      }
      throw new Error(result.error || 'Failed to update project');
    } catch (error) {
      console.error('Failed to update project:', error);
      throw error;
    }
  }

  getProjects(): ProjectRecord[] {
    return this.projects;
  }

  getProjectById(id: string): ProjectRecord | undefined {
    return this.projects.find(p => p.id === id);
  }
}

export const projectsService = new ProjectsService();
